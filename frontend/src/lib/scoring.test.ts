import test from "node:test";
import assert from "node:assert/strict";
import { computeIssueMatch, extractWordTokenSet } from "./scoring";

test("tokenizer prevents substring false positives and preserves special languages", () => {
  const tokens = extractWordTokenSet("google django mongo algorithm");
  assert.equal(tokens.has("go"), false);

  const special = extractWordTokenSet("C and R and .NET with Jupyter Notebook and web3js");
  for (const expected of ["c", "r", ".net", "jupyter", "web3"]) {
    assert.equal(special.has(expected), true, `missing ${expected}`);
  }
});

test("zero skill overlap returns 0 score", () => {
  const res = computeIssueMatch({
    userSkills: new Map([["rust", 1.0]]),
    userLevel: "intermediate",
    tooHardCount: 0,
    repoLang: "python",
    repoTopics: ["django"],
    issueTitle: "Fix login CSS alignment",
    issueLabels: ["good first issue"],
    difficulty: "easy",
    repoHealth: 95,
    createdAt: new Date(),
  });
  assert.equal(res.score, 0);
});

test("too_hard feedback recalibrates difficulty fit toward easier issues", () => {
  const base = {
    userSkills: new Map([["typescript", 1.0]]),
    userLevel: "intermediate",
    repoLang: "typescript",
    repoTopics: ["nextjs"],
    issueTitle: "Refactor worker queue locking",
    issueLabels: ["complex"],
    difficulty: "hard",
    repoHealth: 85,
    createdAt: new Date(),
  };

  const before = computeIssueMatch({ ...base, tooHardCount: 0 });
  const after = computeIssueMatch({ ...base, tooHardCount: 2 });
  assert.ok(after.score < before.score);
});