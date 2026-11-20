import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export async function GET() {
  const res = await pool.query(
    `SELECT full_name, description, language, topics, stars, open_issues_count,
            health_score, responsiveness_score, merge_rate_score, last_synced_at
     FROM repos
     WHERE is_active = TRUE
     ORDER BY health_score DESC, stars DESC
     LIMIT 100`
  );

  const repos = res.rows.map((r) => ({
    full_name: r.full_name as string,
    description: r.description as string,
    language: r.language as string,
    topics: (r.topics ?? []) as string[],
    stars: r.stars as number,
    open_issues: r.open_issues_count as number,
    health_score: r.health_score as number,
    responsiveness: r.responsiveness_score as number | null,
    merge_rate: r.merge_rate_score as number | null,
    last_synced_at: r.last_synced_at
      ? new Date(r.last_synced_at).toISOString().replace("T", " ").slice(0, 16) + " UTC"
      : "Pending next sync",
  }));

  return NextResponse.json({ repos });
}