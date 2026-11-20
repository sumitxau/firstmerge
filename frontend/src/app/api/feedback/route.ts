import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { USERNAME_REGEX } from "@/lib/scoring";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    username?: string;
    issue_id?: number;
    feedback_type?: string;
  } | null;

  const username = (body?.username ?? "").trim().toLowerCase();
  const issueId = Number(body?.issue_id);
  const feedbackType = body?.feedback_type ?? "";

  if (!USERNAME_REGEX.test(username) || !Number.isInteger(issueId)) {
    return NextResponse.json({ error: "Valid username and issue_id required" }, { status: 400 });
  }
  if (!["clicked", "too_hard", "dismissed"].includes(feedbackType)) {
    return NextResponse.json({ error: "Invalid feedback_type" }, { status: 400 });
  }

  const [uRes, iRes] = await Promise.all([
    pool.query<{ id: number }>("SELECT id FROM users WHERE github_username = $1", [username]),
    pool.query<{ id: number }>("SELECT id FROM issues WHERE id = $1", [issueId]),
  ]);
  if (!uRes.rows[0] || !iRes.rows[0]) {
    return NextResponse.json({ error: "User or issue not found" }, { status: 404 });
  }

  await pool.query(
    `INSERT INTO feedback_events (user_id, issue_id, feedback_type) VALUES ($1, $2, $3)`,
    [uRes.rows[0].id, issueId, feedbackType]
  );

  return NextResponse.json({ ok: true });
}