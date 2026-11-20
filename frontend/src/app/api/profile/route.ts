import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { USERNAME_REGEX, normalizeSkillToken } from "@/lib/scoring";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    github_username?: string;
    experience_level?: string;
    manual_skills?: string[];
  } | null;

  const username = (body?.github_username ?? "").trim().toLowerCase();
  if (!USERNAME_REGEX.test(username)) {
    return NextResponse.json({ error: "Invalid GitHub username format" }, { status: 400 });
  }

  const level =
    body?.experience_level === "beginner" || body?.experience_level === "advanced"
      ? body.experience_level
      : "intermediate";
  const manualSkills = Array.isArray(body?.manual_skills) ? body.manual_skills : [];

  const userRes = await pool.query<{ id: number; profile_cached_at: Date | null }>(
    `INSERT INTO users (github_username, experience_level)
     VALUES ($1, $2)
     ON CONFLICT (github_username) DO UPDATE SET experience_level = EXCLUDED.experience_level
     RETURNING id, profile_cached_at`,
    [username, level]
  );
  const { id: userId, profile_cached_at: cachedAt } = userRes.rows[0];

  if (
    cachedAt &&
    Date.now() - new Date(cachedAt).getTime() < 24 * 60 * 60 * 1000 &&
    manualSkills.length === 0
  ) {
    const cached = await pool.query<{ skill_name: string; weight: number }>(
      `SELECT skill_name, weight FROM user_skills WHERE user_id = $1 ORDER BY weight DESC`,
      [userId]
    );
    if (cached.rows.length > 0) {
      return NextResponse.json({
        github_username: username,
        experience_level: level,
        skills: cached.rows.map((r) => ({ skill: r.skill_name, weight: r.weight })),
        cached: true,
      });
    }
  }

  const counts = new Map<string, number>();
  for (const s of manualSkills) {
    const norm = normalizeSkillToken(String(s));
    if (norm) counts.set(norm, (counts.get(norm) ?? 0) + 3.0);
  }

  const headers: Record<string, string> = {
    "User-Agent": "FirstMerge-Web/2.0",
    Accept: "application/vnd.github+json",
  };
  const ghToken = process.env.GH_API_TOKEN?.trim();
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

  const ghRes = await fetch(
    `https://api.github.com/users/${username}/repos?per_page=30&sort=updated`,
    { headers, signal: AbortSignal.timeout(10_000) }
  );

  if (ghRes.status === 404) {
    return NextResponse.json({ error: "GitHub user not found" }, { status: 404 });
  }
  if (!ghRes.ok) {
    return NextResponse.json({ error: "GitHub API rate limit or error" }, { status: 429 });
  }

  const ghRepos = (await ghRes.json()) as Array<{
    fork: boolean;
    language: string | null;
    topics?: string[];
  }>;

  for (const repo of ghRepos) {
    if (repo.fork) continue;
    if (repo.language) {
      const norm = normalizeSkillToken(repo.language);
      if (norm) counts.set(norm, (counts.get(norm) ?? 0) + 2.0);
    }
    for (const t of repo.topics ?? []) {
      const norm = normalizeSkillToken(t);
      if (norm) counts.set(norm, (counts.get(norm) ?? 0) + 1.0);
    }
  }

  const maxVal = Math.max(1, ...counts.values());
  const skills: Array<{ skill: string; weight: number }> = [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM user_skills WHERE user_id = $1", [userId]);

    for (const [k, v] of counts.entries()) {
      const weight = Math.round((v / maxVal) * 100) / 100;
      if (weight < 0.15) continue;
      await client.query(
        "INSERT INTO user_skills (user_id, skill_name, weight) VALUES ($1, $2, $3)",
        [userId, k, weight]
      );
      skills.push({ skill: k, weight });
    }

    await client.query("UPDATE users SET profile_cached_at = NOW() WHERE id = $1", [userId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[profile] tx error:", err);
    return NextResponse.json({ error: "Failed to save skill profile" }, { status: 500 });
  } finally {
    client.release();
  }

  skills.sort((a, b) => b.weight - a.weight);
  return NextResponse.json({
    github_username: username,
    experience_level: level,
    skills,
    cached: false,
  });
}