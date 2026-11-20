package core

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lib/pq"
)

var (
	ErrRepoNotFound = errors.New("repository not found (404)")
	linkNextRegex   = regexp.MustCompile(`<([^>]+)>;\s*rel="next"`)
)

func GitHubToken() string {
	if t := strings.TrimSpace(os.Getenv("GH_API_TOKEN")); t != "" {
		return t
	}
	return strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
}

func AddGitHubHeaders(req *http.Request) {
	req.Header.Set("User-Agent", "FirstMerge-Engine/2.0")
	req.Header.Set("Accept", "application/vnd.github+json")
	if token := GitHubToken(); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
}

func RespectRateLimit(resp *http.Response) {
	if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
		if secs, err := strconv.Atoi(retryAfter); err == nil && secs > 0 && secs <= 180 {
			time.Sleep(time.Duration(secs) * time.Second)
			return
		}
	}
	if rem := resp.Header.Get("X-RateLimit-Remaining"); rem != "" {
		if n, err := strconv.Atoi(rem); err == nil && n < 10 {
			if resetStr := resp.Header.Get("X-RateLimit-Reset"); resetStr != "" {
				if resetUnix, err := strconv.ParseInt(resetStr, 10, 64); err == nil {
					waitDur := time.Until(time.Unix(resetUnix, 0)) + 2*time.Second
					if waitDur > 0 && waitDur <= 5*time.Minute {
						slog.Warn("rate limit low; sleeping until reset", "wait", waitDur)
						time.Sleep(waitDur)
						return
					}
				}
			}
			time.Sleep(30 * time.Second)
		}
	}
}

func ReapStuckJobs(ctx context.Context) error {
	res, err := DB.ExecContext(ctx, `
		UPDATE jobs
		SET status = 'pending', locked_at = NULL, locked_by = ''
		WHERE status = 'running' AND locked_at < NOW() - INTERVAL '10 minutes'
	`)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		slog.Info("reaped stuck jobs back to pending", "count", n)
	}
	return nil
}

func RunWorkerPool(ctx context.Context, concurrency int) error {
	if err := ReapStuckJobs(ctx); err != nil {
		slog.Warn("reaper warning", "err", err)
	}

	client := &http.Client{Timeout: 25 * time.Second}
	var wg sync.WaitGroup

	for i := 1; i <= concurrency; i++ {
		wg.Add(1)
		workerName := fmt.Sprintf("go-worker-%d", i)
		go func(name string) {
			defer wg.Done()
			for {
				if ctx.Err() != nil {
					return
				}
				claimed, err := claimAndExecuteJob(ctx, client, name)
				if err != nil {
					slog.Warn("job execution error", "worker", name, "err", err)
				}
				if !claimed {
					return
				}
			}
		}(workerName)
	}

	wg.Wait()
	return nil
}

func claimAndExecuteJob(ctx context.Context, client *http.Client, workerName string) (bool, error) {
	tx, err := DB.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}

	var jobID, attempts int
	var jobType, payload string

	err = tx.QueryRowContext(ctx, `
		SELECT id, job_type, payload, attempts
		FROM jobs
		WHERE status = 'pending' AND run_at <= NOW() AND attempts < 5
		ORDER BY run_at ASC
		LIMIT 1
		FOR UPDATE SKIP LOCKED
	`).Scan(&jobID, &jobType, &payload, &attempts)

	if errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return false, nil
	}
	if err != nil {
		_ = tx.Rollback()
		return false, err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE jobs
		SET status = 'running', locked_at = NOW(), locked_by = $1, attempts = attempts + 1
		WHERE id = $2
	`, workerName, jobID); err != nil {
		_ = tx.Rollback()
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}

	slog.Info("claimed job", "worker", workerName, "job_id", jobID, "repo", payload)
	syncErr := SyncRepository(ctx, client, payload)

	// Fresh 5s context ensures a shutdown signal never leaves a job stuck in 'running'
	statusCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if syncErr != nil {
		if errors.Is(syncErr, ErrRepoNotFound) {
			_, _ = DB.ExecContext(statusCtx, `
				UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = '', last_error = $1
				WHERE id = $2
			`, syncErr.Error(), jobID)
			return true, nil
		}
		backoffMins := int(math.Min(math.Pow(2, float64(attempts))*5, 360))
		_, _ = DB.ExecContext(statusCtx, `
			UPDATE jobs
			SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
			    locked_at = NULL,
			    locked_by = '',
			    last_error = $1,
			    run_at = NOW() + ($2 || ' minutes')::INTERVAL
			WHERE id = $3
		`, syncErr.Error(), strconv.Itoa(backoffMins), jobID)
		return true, syncErr
	}

	_, _ = DB.ExecContext(statusCtx, `
		UPDATE jobs
		SET status = 'pending',
		    attempts = 0,
		    locked_at = NULL,
		    locked_by = '',
		    last_error = '',
		    run_at = NOW() + INTERVAL '4 hours'
		WHERE id = $1
	`, jobID)
	return true, nil
}

func parseNextPageURL(linkHeader string) string {
	m := linkNextRegex.FindStringSubmatch(linkHeader)
	if len(m) == 2 {
		return m[1]
	}
	return ""
}

func SyncRepository(ctx context.Context, client *http.Client, fullName string) error {
	if !RepoFullNameRegex.MatchString(fullName) {
		return fmt.Errorf("%w: invalid format %s", ErrRepoNotFound, fullName)
	}

	var repoID int
	var savedETag string
	var lastSynced, metaUpdated sql.NullTime

	err := DB.QueryRowContext(ctx, `
		SELECT id, etag, last_synced_at, meta_updated_at
		FROM repos WHERE full_name = $1
	`, fullName).Scan(&repoID, &savedETag, &lastSynced, &metaUpdated)
	if err != nil {
		return err
	}

	if !metaUpdated.Valid || time.Since(metaUpdated.Time) > 24*time.Hour {
		if err := refreshRepoHealth(ctx, client, repoID, fullName); err != nil {
			return err
		}
	}

	// 2-minute overlap buffer prevents missing an issue updated mid-sync
	syncStartedAt := time.Now().UTC().Add(-2 * time.Minute)
	nextURL := fmt.Sprintf("https://api.github.com/repos/%s/issues?state=all&sort=updated&direction=desc&per_page=100", fullName)
	firstPageETag := ""
	deepChecksRemaining := 6

	for page := 1; page <= 5 && nextURL != ""; page++ {
		req, err := http.NewRequestWithContext(ctx, "GET", nextURL, nil)
		if err != nil {
			return err
		}
		AddGitHubHeaders(req)
		if page == 1 && savedETag != "" {
			req.Header.Set("If-None-Match", savedETag)
		}

		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		RespectRateLimit(resp)

		if page == 1 && resp.StatusCode == http.StatusNotModified {
			resp.Body.Close()
			slog.Info("304 Not Modified (0 quota used)", "repo", fullName)
			_, _ = DB.ExecContext(ctx, `UPDATE repos SET last_synced_at = $1 WHERE id = $2`, syncStartedAt, repoID)
			return nil
		}
		if resp.StatusCode == http.StatusNotFound {
			resp.Body.Close()
			_, _ = DB.ExecContext(ctx, `UPDATE repos SET is_active = FALSE WHERE id = $1`, repoID)
			return fmt.Errorf("%w: %s", ErrRepoNotFound, fullName)
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			resp.Body.Close()
			return fmt.Errorf("github issues status %d", resp.StatusCode)
		}

		if page == 1 {
			firstPageETag = resp.Header.Get("ETag")
		}
		nextLink := parseNextPageURL(resp.Header.Get("Link"))

		var items []struct {
			ID          int64  `json:"id"`
			Number      int    `json:"number"`
			Title       string `json:"title"`
			Body        string `json:"body"`
			HTMLURL     string `json:"html_url"`
			State       string `json:"state"`
			Comments    int    `json:"comments"`
			CreatedAt   string `json:"created_at"`
			UpdatedAt   string `json:"updated_at"`
			Assignee    *struct{ Login string `json:"login"` } `json:"assignee"`
			PullRequest *struct{ URL string `json:"url"` }     `json:"pull_request"`
			Labels      []struct{ Name string `json:"name"` }  `json:"labels"`
		}
		decodeErr := json.NewDecoder(resp.Body).Decode(&items)
		resp.Body.Close()
		if decodeErr != nil {
			return decodeErr
		}

		reachedOld := false
		for _, item := range items {
			if item.PullRequest != nil {
				continue
			}
			updatedAt, err := time.Parse(time.RFC3339, item.UpdatedAt)
			if err != nil {
				continue
			}
			if lastSynced.Valid && updatedAt.Before(lastSynced.Time) {
				reachedOld = true
				break
			}

			createdAt, _ := time.Parse(time.RFC3339, item.CreatedAt)
			assigneeLogin := ""
			if item.Assignee != nil {
				assigneeLogin = SanitizeUTF8(item.Assignee.Login)
			}

			labels := make([]string, 0, len(item.Labels))
			for _, l := range item.Labels {
				labels = append(labels, SanitizeUTF8(strings.ToLower(l.Name)))
			}

			diff := EstimateIssueDifficulty(labels, item.Body, item.Comments)
			cleanTitle := TruncateRunes(item.Title, 220)
			excerpt := TruncateRunes(item.Body, 260)
			state := "open"
			if item.State == "closed" {
				state = "closed"
			}

			claimedInComments := false
			hasOpenPR := false
			if state == "open" && assigneeLogin == "" && deepChecksRemaining > 0 {
				deepChecksRemaining--
				if item.Comments > 0 {
					claimedInComments = checkIssueCommentsForClaim(ctx, client, fullName, item.Number)
				}
				hasOpenPR = checkIssueTimelineForOpenPR(ctx, client, fullName, item.Number)
			}

			if _, err := DB.ExecContext(ctx, `
				INSERT INTO issues (
					github_id, repo_id, number, title, body_excerpt, html_url,
					labels, state, assignee, claimed_in_comments, has_open_pr,
					comments_checked_at, comment_count, difficulty, created_at, updated_at
				) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12,$13,$14,$15)
				ON CONFLICT (github_id) DO UPDATE SET
					title = EXCLUDED.title,
					body_excerpt = EXCLUDED.body_excerpt,
					labels = EXCLUDED.labels,
					state = EXCLUDED.state,
					assignee = EXCLUDED.assignee,
					claimed_in_comments = EXCLUDED.claimed_in_comments,
					has_open_pr = EXCLUDED.has_open_pr,
					comments_checked_at = NOW(),
					comment_count = EXCLUDED.comment_count,
					difficulty = EXCLUDED.difficulty,
					updated_at = EXCLUDED.updated_at
			`, item.ID, repoID, item.Number, cleanTitle, excerpt, item.HTMLURL,
				pq.Array(labels), state, assigneeLogin, claimedInComments, hasOpenPR,
				item.Comments, diff, createdAt, updatedAt); err != nil {
				return fmt.Errorf("upsert issue #%d: %w", item.Number, err)
			}
		}

		if reachedOld {
			break
		}
		nextURL = nextLink
	}

	_, err = DB.ExecContext(ctx, `
		UPDATE repos SET etag = $1, last_synced_at = $2 WHERE id = $3
	`, firstPageETag, syncStartedAt, repoID)
	return err
}

func checkIssueCommentsForClaim(ctx context.Context, client *http.Client, fullName string, issueNumber int) bool {
	url := fmt.Sprintf("https://api.github.com/repos/%s/issues/%d/comments?per_page=10", fullName, issueNumber)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return false
	}
	AddGitHubHeaders(req)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var comments []struct {
		Body string `json:"body"`
	}
	if json.NewDecoder(resp.Body).Decode(&comments) != nil {
		return false
	}
	for _, c := range comments {
		if IsClaimedInComment(c.Body) {
			return true
		}
	}
	return false
}

func checkIssueTimelineForOpenPR(ctx context.Context, client *http.Client, fullName string, issueNumber int) bool {
	url := fmt.Sprintf("https://api.github.com/repos/%s/issues/%d/timeline?per_page=20", fullName, issueNumber)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return false
	}
	AddGitHubHeaders(req)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var events []struct {
		Event  string `json:"event"`
		Source *struct {
			Issue *struct {
				State       string                 `json:"state"`
				PullRequest map[string]interface{} `json:"pull_request"`
			} `json:"issue"`
		} `json:"source"`
	}
	if json.NewDecoder(resp.Body).Decode(&events) != nil {
		return false
	}
	for _, ev := range events {
		if ev.Event == "cross-referenced" && ev.Source != nil && ev.Source.Issue != nil {
			if ev.Source.Issue.PullRequest != nil && ev.Source.Issue.State == "open" {
				return true
			}
		}
	}
	return false
}

func refreshRepoHealth(ctx context.Context, client *http.Client, repoID int, fullName string) error {
	parts := strings.SplitN(fullName, "/", 2)
	if len(parts) != 2 {
		return fmt.Errorf("%w: %s", ErrRepoNotFound, fullName)
	}

	if GitHubToken() != "" {
		if err := refreshViaGraphQL(ctx, client, repoID, parts[0], parts[1]); err == nil {
			return nil
		}
	}

	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/"+fullName, nil)
	if err != nil {
		return err
	}
	AddGitHubHeaders(req)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	RespectRateLimit(resp)

	if resp.StatusCode == http.StatusNotFound {
		_, _ = DB.ExecContext(ctx, `UPDATE repos SET is_active = FALSE WHERE id = $1`, repoID)
		return fmt.Errorf("%w: %s", ErrRepoNotFound, fullName)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("repo meta status %d", resp.StatusCode)
	}

	var meta struct {
		Description     string   `json:"description"`
		Language        string   `json:"language"`
		Topics          []string `json:"topics"`
		StargazersCount int      `json:"stargazers_count"`
		OpenIssuesCount int      `json:"open_issues_count"`
		PushedAt        string   `json:"pushed_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		return err
	}

	pushedAt, _ := time.Parse(time.RFC3339, meta.PushedAt)
	totalHealth, respPtr, mergePtr := ComputeHealthScore(RepoHealthInput{
		MedianReplyHours: -1,
		OutsideMergeRate: -1,
		DaysSincePush:    time.Since(pushedAt).Hours() / 24,
		HasGoodFirst:     true,
		HasContributing:  false,
	})

	_, err = DB.ExecContext(ctx, `
		UPDATE repos
		SET description = $1, language = $2, topics = $3, stars = $4,
		    open_issues_count = $5, last_pushed_at = $6, health_score = $7,
		    responsiveness_score = $8, merge_rate_score = $9, meta_updated_at = NOW()
		WHERE id = $10
	`, TruncateRunes(meta.Description, 200), strings.ToLower(meta.Language),
		pq.Array(meta.Topics), meta.StargazersCount, meta.OpenIssuesCount,
		pushedAt, totalHealth, respPtr, mergePtr, repoID)
	return err
}

func refreshViaGraphQL(ctx context.Context, client *http.Client, repoID int, owner, name string) error {
	query := `
	query($owner: String!, $name: String!) {
	  repository(owner: $owner, name: $name) {
	    description
	    stargazerCount
	    pushedAt
	    primaryLanguage { name }
	    openIssues: issues(states: OPEN) { totalCount }
	    contributingFile: object(expression: "HEAD:CONTRIBUTING.md") { id }
	    repositoryTopics(first: 15) { nodes { topic { name } } }
	    recentIssues: issues(last: 20, orderBy: {field: CREATED_AT, direction: DESC}) {
	      nodes {
	        createdAt
	        comments(first: 5) {
	          nodes { createdAt authorAssociation }
	        }
	      }
	    }
	    recentPRs: pullRequests(last: 25, states: [MERGED, CLOSED]) {
	      nodes { merged authorAssociation }
	    }
	  }
	}`

	reqBody, _ := json.Marshal(map[string]interface{}{
		"query":     query,
		"variables": map[string]string{"owner": owner, "name": name},
	})

	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.github.com/graphql", bytes.NewBuffer(reqBody))
	if err != nil {
		return err
	}
	AddGitHubHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("graphql status %d", resp.StatusCode)
	}

	var gqlResp struct {
		Data struct {
			Repository *struct {
				Description      string `json:"description"`
				StargazerCount   int    `json:"stargazerCount"`
				PushedAt         string `json:"pushedAt"`
				PrimaryLanguage  *struct{ Name string } `json:"primaryLanguage"`
				OpenIssues       struct{ TotalCount int } `json:"openIssues"`
				ContributingFile *struct{ ID string } `json:"contributingFile"`
				RepositoryTopics struct {
					Nodes []struct {
						Topic struct{ Name string } `json:"topic"`
					} `json:"nodes"`
				} `json:"repositoryTopics"`
				RecentIssues struct {
					Nodes []struct {
						CreatedAt string `json:"createdAt"`
						Comments  struct {
							Nodes []struct {
								CreatedAt         string `json:"createdAt"`
								AuthorAssociation string `json:"authorAssociation"`
							} `json:"nodes"`
						} `json:"comments"`
					} `json:"nodes"`
				} `json:"recentIssues"`
				RecentPRs struct {
					Nodes []struct {
						Merged            bool   `json:"merged"`
						AuthorAssociation string `json:"authorAssociation"`
					} `json:"nodes"`
				} `json:"recentPRs"`
			} `json:"repository"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&gqlResp); err != nil || gqlResp.Data.Repository == nil {
		return fmt.Errorf("graphql decode failed")
	}
	r := gqlResp.Data.Repository

	var replyHours []float64
	for _, iss := range r.RecentIssues.Nodes {
		issTime, err := time.Parse(time.RFC3339, iss.CreatedAt)
		if err != nil {
			continue
		}
		for _, c := range iss.Comments.Nodes {
			if c.AuthorAssociation == "OWNER" || c.AuthorAssociation == "MEMBER" || c.AuthorAssociation == "COLLABORATOR" {
				if cTime, err := time.Parse(time.RFC3339, c.CreatedAt); err == nil && cTime.After(issTime) {
					replyHours = append(replyHours, cTime.Sub(issTime).Hours())
					break
				}
			}
		}
	}

	medianReply := -1.0
	if len(replyHours) >= 2 {
		medianReply = MedianFloat64(replyHours)
	}

	outsideTotal, outsideMerged := 0, 0
	for _, pr := range r.RecentPRs.Nodes {
		if pr.AuthorAssociation != "OWNER" && pr.AuthorAssociation != "MEMBER" {
			outsideTotal++
			if pr.Merged {
				outsideMerged++
			}
		}
	}
	mergeRate := -1.0
	if outsideTotal >= 2 {
		mergeRate = float64(outsideMerged) / float64(outsideTotal)
	}

	pushedAt, _ := time.Parse(time.RFC3339, r.PushedAt)
	topics := make([]string, 0, len(r.RepositoryTopics.Nodes))
	for _, tn := range r.RepositoryTopics.Nodes {
		topics = append(topics, strings.ToLower(tn.Topic.Name))
	}
	lang := ""
	if r.PrimaryLanguage != nil {
		lang = strings.ToLower(r.PrimaryLanguage.Name)
	}

	totalHealth, respPtr, mergePtr := ComputeHealthScore(RepoHealthInput{
		MedianReplyHours: medianReply,
		OutsideMergeRate: mergeRate,
		DaysSincePush:    time.Since(pushedAt).Hours() / 24,
		HasGoodFirst:     true,
		HasContributing:  r.ContributingFile != nil,
	})

	_, err = DB.ExecContext(ctx, `
		UPDATE repos
		SET description = $1, language = $2, topics = $3, stars = $4,
		    open_issues_count = $5, last_pushed_at = $6, health_score = $7,
		    responsiveness_score = $8, merge_rate_score = $9, meta_updated_at = NOW()
		WHERE id = $10
	`, TruncateRunes(r.Description, 200), lang, pq.Array(topics),
		r.StargazerCount, r.OpenIssues.TotalCount, pushedAt,
		totalHealth, respPtr, mergePtr, repoID)
	return err
}
