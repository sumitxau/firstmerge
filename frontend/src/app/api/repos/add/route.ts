import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { REPO_REGEX } from "@/lib/scoring";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { full_name?: string } | null;

  const cleaned = String(body?.full_name ?? "")
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");

  const parts = cleaned.split("/").filter(Boolean);
  const fullName =
    parts.length >= 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : cleaned.toLowerCase();

  if (!REPO_REGEX.test(fullName)) {
    return NextResponse.json(
      { error: "Use owner/repo or a valid GitHub repo URL (e.g. vercel/next.js)" },
      { status: 400 }
    );
  }

  const countRes = await pool.query<{ count: string }>("SELECT COUNT(*) FROM repos");
  if (Number(countRes.rows[0]?.count ?? 0) >= 150) {
    return NextResponse.json({ error: "Repository tracking cap (150) reached" }, { status: 403 });
  }

  await pool.query(
    `INSERT INTO repos (full_name) VALUES ($1) ON CONFLICT (full_name) DO NOTHING`,
    [fullName]
  );

  await pool.query(
    `INSERT INTO jobs (job_type, payload, status, run_at)
     VALUES ('refresh_repo', $1, 'pending', NOW())
     ON CONFLICT (job_type, payload) DO UPDATE SET
       status = CASE WHEN jobs.status = 'running' THEN 'running' ELSE 'pending' END,
       attempts = CASE WHEN jobs.status IN ('failed', 'done') THEN 0 ELSE jobs.attempts END,
       run_at = CASE WHEN jobs.status = 'running' THEN jobs.run_at ELSE NOW() END`,
    [fullName]
  );

  return NextResponse.json({
    queued: fullName,
    message: "Queued for the next scheduled Go worker run.",
  });
}