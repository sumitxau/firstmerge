import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { USERNAME_REGEX, computeIssueMatch } from "@/lib/scoring";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const username = (searchParams.get("username") ?? "").trim().toLowerCase();
  const q = (searchParams.get("q") ?? "").trim();
  const difficulty = (searchParams.get("difficulty") ?? "").trim();

  let userId = 0;
  let userLevel = "intermediate";
  let tooHardCount = 0;
  const userSkills = new Map<string, number>();

  if (username && USERNAME_REGEX.test(username)) {
    const uRes = await pool.query<{ id: number; experience_level: string }>(
      `SELECT id, experience_level FROM users WHERE github_username = $1`,
      [username]
    );
    if (uRes.rows[0]) {
      userId = uRes.rows[0].id;
      userLevel = uRes.rows[0].experience_level;

      const [thRes, skRes] = await Promise.all([
        pool.query<{ count: string }>(
          `SELECT COUNT(*) FROM feedback_events WHERE user_id = $1 AND feedback_type = 'too_hard'`,
          [userId]
        ),
        pool.query<{ skill_name: string; weight: number }>(
          `SELECT skill_name, weight FROM user_skills WHERE user_id = $1`,
          [userId]
        ),
      ]);
      tooHardCount = Number(thRes.rows[0]?.count ?? 0);
      for (const row of skRes.rows) userSkills.set(row.skill_name, row.weight);
    }
  }

  const args: unknown[] = [userId];
  const where: string[] = [
    "i.state = 'open'",
    "i.assignee = ''",
    "i.claimed_in_comments = FALSE",
    "i.has_open_pr = FALSE",
    "r.is_active = TRUE",
    "NOT EXISTS (SELECT 1 FROM feedback_events fe WHERE fe.user_id = $1 AND fe.issue_id = i.id AND fe.feedback_type = 'dismissed')",
  ];

  if (q) {
    args.push(q);
    where.push(`i.search_tsv @@ websearch_to_tsquery('english', $${args.length})`);
  }
  if (difficulty && ["easy", "medium", "hard"].includes(difficulty)) {
    args.push(difficulty);
    where.push(`i.difficulty = $${args.length}`);
  }

  const res = await pool.query(
    `SELECT i.id, i.number, i.title, i.body_excerpt, i.html_url, i.labels,
            i.difficulty, i.comment_count, i.created_at, i.updated_at,
            r.full_name, r.language, r.topics, r.health_score, r.stars
     FROM issues i
     JOIN repos r ON r.id = i.repo_id
     WHERE ${where.join(" AND ")}
     ORDER BY i.updated_at DESC
     LIMIT 400`,
    args
  );

  const matched = res.rows
    .map((row) => {
      const createdAt = new Date(row.created_at);
      const updatedAt = new Date(row.updated_at);
      const { score, reason } = computeIssueMatch({
        userSkills,
        userLevel,
        tooHardCount,
        repoLang: row.language ?? "",
        repoTopics: row.topics ?? [],
        issueTitle: row.title ?? "",
        issueLabels: row.labels ?? [],
        difficulty: row.difficulty ?? "medium",
        repoHealth: row.health_score ?? 70,
        createdAt,
      });

      return {
        issue_id: row.id as number,
        number: row.number as number,
        title: row.title as string,
        body_excerpt: row.body_excerpt as string,
        html_url: row.html_url as string,
        labels: (row.labels ?? []) as string[],
        difficulty: row.difficulty as string,
        comment_count: row.comment_count as number,
        repo_name: row.full_name as string,
        repo_language: row.language as string,
        repo_health: row.health_score as number,
        repo_stars: row.stars as number,
        match_score: score,
        match_reason: reason,
        created_at: createdAt.toISOString().slice(0, 10),
        _updatedMs: updatedAt.getTime(),
      };
    })
    .filter((it) => it.match_score > 0)
    .sort((a, b) =>
      b.match_score !== a.match_score
        ? b.match_score - a.match_score
        : b._updatedMs - a._updatedMs
    )
    .slice(0, 40)
    .map(({ _updatedMs, ...clean }) => clean);

  return NextResponse.json({ issues: matched });
}