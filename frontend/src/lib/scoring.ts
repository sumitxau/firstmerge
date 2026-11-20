export const REPO_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const USERNAME_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const SKILL_ALIASES: Record<string, string> = {
  golang: "go",
  ts: "typescript",
  js: "javascript",
  nodejs: "node.js",
  node: "node.js",
  nextjs: "next.js",
  reactjs: "react",
  postgres: "postgresql",
  web3js: "web3",
  "jupyter notebook": "jupyter",
  csharp: "c#",
  cplusplus: "c++",
};

const SINGLE_CHAR_ALLOWED = new Set(["c", "r"]);

export function normalizeSkillToken(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (SKILL_ALIASES[s]) return SKILL_ALIASES[s];
  if (!s.startsWith(".net")) {
    s = s.replace(/^[.-]+|[.-]+$/g, "");
  }
  return SKILL_ALIASES[s] ?? s;
}

export function extractWordTokenSet(...texts: string[]): Set<string> {
  const set = new Set<string>();
  for (const t of texts) {
    const lower = t.toLowerCase();
    if (lower.includes("jupyter notebook")) set.add("jupyter");
    if (lower.includes(".net")) set.add(".net");

    const parts = lower.split(/[^a-z0-9+#.-]+/);
    for (const p of parts) {
      const norm = normalizeSkillToken(p);
      if (norm.length >= 2 || SINGLE_CHAR_ALLOWED.has(norm)) {
        set.add(norm);
      }
    }
  }
  return set;
}

export function computeIssueMatch(params: {
  userSkills: Map<string, number>;
  userLevel: string;
  tooHardCount: number;
  repoLang: string;
  repoTopics: string[];
  issueTitle: string;
  issueLabels: string[];
  difficulty: string;
  repoHealth: number;
  createdAt: Date;
}): { score: number; reason: string } {
  const {
    userSkills,
    userLevel,
    tooHardCount,
    repoLang,
    repoTopics,
    issueTitle,
    issueLabels,
    difficulty,
    repoHealth,
    createdAt,
  } = params;

  const tokenSet = extractWordTokenSet(
    repoLang,
    repoTopics.join(" "),
    issueTitle,
    issueLabels.join(" ")
  );

  let bestWeight = 0;
  const matchedSkills: string[] = [];

  for (const [skill, weight] of userSkills.entries()) {
    const norm = normalizeSkillToken(skill);
    if (tokenSet.has(norm)) {
      matchedSkills.push(norm);
      if (weight > bestWeight) bestWeight = weight;
    }
  }

  if (userSkills.size > 0 && bestWeight === 0) {
    return { score: 0, reason: "" };
  }
  if (userSkills.size === 0) {
    bestWeight = 0.65;
  }

  // If user clicks "Too Hard" 2+ times, gently shift recommendations toward easier issues
  let effectiveLevel = userLevel;
  if (tooHardCount >= 2 && effectiveLevel === "advanced") effectiveLevel = "intermediate";
  else if (tooHardCount >= 2 && effectiveLevel === "intermediate") effectiveLevel = "beginner";

  const healthNorm = repoHealth / 100;

  let diffFit = 0.7;
  if (effectiveLevel === "beginner") {
    diffFit = difficulty === "easy" ? 1.0 : difficulty === "medium" ? 0.6 : 0.25;
  } else if (effectiveLevel === "advanced") {
    diffFit = difficulty === "hard" || difficulty === "medium" ? 1.0 : 0.7;
  } else {
    diffFit = difficulty === "medium" || difficulty === "easy" ? 0.95 : 0.6;
  }

  const daysOld = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  const freshness = daysOld <= 3 ? 1.0 : daysOld <= 14 ? 0.85 : daysOld <= 45 ? 0.68 : 0.45;

  const raw = (0.35 * bestWeight + 0.25 * healthNorm + 0.2 * diffFit + 0.2 * freshness) * 100;
  const score = Math.min(99, Math.round(raw));

  const reasons: string[] = [];
  if (matchedSkills.length > 0) {
    reasons.push(`Matches ${matchedSkills.slice(0, 3).join(", ")}`);
  }
  reasons.push(`Repo health ${repoHealth}/100`);
  if (difficulty === "easy") reasons.push("Beginner-friendly");
  else if (daysOld <= 14) reasons.push("Fresh & unassigned");

  return { score, reason: reasons.join(" · ") };
}

