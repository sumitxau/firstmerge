package core

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	_ "github.com/lib/pq"
)

var DB *sql.DB

const SchemaSQL = `
CREATE TABLE IF NOT EXISTS users (
	id SERIAL PRIMARY KEY,
	github_username TEXT UNIQUE NOT NULL,
	experience_level TEXT NOT NULL DEFAULT 'intermediate'
		CHECK (experience_level IN ('beginner', 'intermediate', 'advanced')),
	profile_cached_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_skills (
	user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	skill_name TEXT NOT NULL,
	weight DOUBLE PRECISION NOT NULL,
	PRIMARY KEY (user_id, skill_name)
);

CREATE TABLE IF NOT EXISTS repos (
	id SERIAL PRIMARY KEY,
	full_name TEXT UNIQUE NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	language TEXT NOT NULL DEFAULT '',
	topics TEXT[] NOT NULL DEFAULT '{}',
	stars INT NOT NULL DEFAULT 0,
	open_issues_count INT NOT NULL DEFAULT 0,
	last_pushed_at TIMESTAMPTZ,
	health_score INT NOT NULL DEFAULT 70,
	responsiveness_score INT,
	merge_rate_score INT,
	etag TEXT NOT NULL DEFAULT '',
	last_synced_at TIMESTAMPTZ,
	meta_updated_at TIMESTAMPTZ,
	is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS issues (
	id SERIAL PRIMARY KEY,
	github_id BIGINT UNIQUE NOT NULL,
	repo_id INT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
	number INT NOT NULL,
	title TEXT NOT NULL,
	body_excerpt TEXT NOT NULL DEFAULT '',
	html_url TEXT NOT NULL,
	labels TEXT[] NOT NULL DEFAULT '{}',
	state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
	assignee TEXT NOT NULL DEFAULT '',
	claimed_in_comments BOOLEAN NOT NULL DEFAULT FALSE,
	has_open_pr BOOLEAN NOT NULL DEFAULT FALSE,
	comments_checked_at TIMESTAMPTZ,
	comment_count INT NOT NULL DEFAULT 0,
	difficulty TEXT NOT NULL DEFAULT 'medium'
		CHECK (difficulty IN ('easy', 'medium', 'hard', 'unknown')),
	created_at TIMESTAMPTZ NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL,
	search_tsv TSVECTOR GENERATED ALWAYS AS (
		to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_excerpt, ''))
	) STORED
);

CREATE INDEX IF NOT EXISTS idx_issues_search_tsv ON issues USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_issues_repo_id ON issues (repo_id);
CREATE INDEX IF NOT EXISTS idx_issues_available
	ON issues (state, assignee, claimed_in_comments, has_open_pr);

CREATE TABLE IF NOT EXISTS feedback_events (
	id SERIAL PRIMARY KEY,
	user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	issue_id INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
	feedback_type TEXT NOT NULL CHECK (feedback_type IN ('clicked', 'too_hard', 'dismissed')),
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_user_issue ON feedback_events (user_id, issue_id);

CREATE TABLE IF NOT EXISTS jobs (
	id SERIAL PRIMARY KEY,
	job_type TEXT NOT NULL,
	payload TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'running', 'done', 'failed')),
	run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	locked_at TIMESTAMPTZ,
	locked_by TEXT NOT NULL DEFAULT '',
	attempts INT NOT NULL DEFAULT 0,
	last_error TEXT NOT NULL DEFAULT '',
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	UNIQUE (job_type, payload)
);

CREATE INDEX IF NOT EXISTS idx_jobs_pending_run_at
	ON jobs (run_at) WHERE status = 'pending';
`

var StarterRepos = []string{
	"calcom/cal.com",
	"dubinc/dub",
	"excalidraw/excalidraw",
	"shadcn-ui/ui",
	"triggerdotdev/trigger.dev",
	"continuedev/continue",
	"prometheus/prometheus",
	"gohugoio/hugo",
}

func SanitizeUTF8(s string) string {
	return strings.ReplaceAll(s, "\x00", "")
}

func InitDB(ctx context.Context) error {
	dbURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dbURL == "" {
		return fmt.Errorf("DATABASE_URL environment variable is required")
	}

	var err error
	DB, err = sql.Open("postgres", dbURL)
	if err != nil {
		return fmt.Errorf("sql.Open: %w", err)
	}
	DB.SetMaxOpenConns(8)
	DB.SetMaxIdleConns(2)
	DB.SetConnMaxLifetime(15 * time.Minute)

	// Retry up to 3 times in case Neon serverless Postgres is waking up from sleep
	for attempt := 1; attempt <= 3; attempt++ {
		pingCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		err = DB.PingContext(pingCtx)
		cancel()
		if err == nil {
			break
		}
		slog.Warn("database ping retry (Neon waking up)", "attempt", attempt, "err", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		return fmt.Errorf("db.Ping failed: %w", err)
	}

	if _, err := DB.ExecContext(ctx, SchemaSQL); err != nil {
		return fmt.Errorf("schema migration failed: %w", err)
	}

	if err := seedStarterRepos(ctx); err != nil {
		slog.Warn("starter repo seed warning", "err", err)
	}
	slog.Info("PostgreSQL schema, indexes, and starter queue verified")
	return nil
}

func seedStarterRepos(ctx context.Context) error {
	for _, fullName := range StarterRepos {
		if _, err := DB.ExecContext(ctx, `
			INSERT INTO repos (full_name) VALUES ($1)
			ON CONFLICT (full_name) DO NOTHING
		`, fullName); err != nil {
			return err
		}
		if _, err := DB.ExecContext(ctx, `
			INSERT INTO jobs (job_type, payload, status, run_at)
			VALUES ('refresh_repo', $1, 'pending', NOW())
			ON CONFLICT (job_type, payload) DO NOTHING
		`, fullName); err != nil {
			return err
		}
	}
	return nil
}
