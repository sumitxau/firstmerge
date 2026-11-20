"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";

function cleanExcerpt(text: string): string {
  return text
    .replace(/#{1,6}\s*/g, "")               // remove ### headings
    .replace(/```[\s\S]*?```/g, "")          // remove fenced code blocks
    .replace(/`([^`]+)`/g, "$1")             // remove inline backticks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // turn [label](url) into label
    .replace(/[*_~>-]{2,}/g, "")             // remove bold/quote/hr symbols
    .replace(/\s+/g, " ")                    // collapse extra spaces/newlines
    .trim();
}

interface SkillItem {
  skill: string;
  weight: number;
}

interface IssueItem {
  issue_id: number;
  number: number;
  title: string;
  body_excerpt: string;
  html_url: string;
  labels: string[];
  difficulty: string;
  comment_count: number;
  repo_name: string;
  repo_language: string;
  repo_health: number;
  repo_stars: number;
  match_score: number;
  match_reason: string;
  created_at: string;
}

interface RepoItem {
  full_name: string;
  description: string;
  language: string;
  topics: string[];
  stars: number;
  open_issues: number;
  health_score: number;
  responsiveness: number | null;
  merge_rate: number | null;
  last_synced_at: string;
}

export function FirstMergeStudio() {
  const [activeTab, setActiveTab] = useState<"issues" | "repos">("issues");
  const [typedUsername, setTypedUsername] = useState("");
  const [activeUsername, setActiveUsername] = useState("");
  const [level, setLevel] = useState("intermediate");
  const [manualSkillInput, setManualSkillInput] = useState("");
  const [skills, setSkills] = useState<SkillItem[]>([]);

  const [typedSearch, setTypedSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState("");

  const [issues, setIssues] = useState<IssueItem[]>([]);
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [newRepoInput, setNewRepoInput] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  const [syncingProfile, setSyncingProfile] = useState(false);
  const [loadingIssues, setLoadingIssues] = useState(true);

  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(typedSearch), 280);
    return () => clearTimeout(timer);
  }, [typedSearch]);

  const fetchRepos = useCallback(async () => {
    try {
      const res = await fetch("/api/repos");
      if (res.ok) {
        const data = await res.json();
        setRepos(data.repos ?? []);
      }
    } catch {
      return;
    }
  }, []);

  const fetchIssues = useCallback(
    async (user: string, q: string, diff: string, signal?: AbortSignal) => {
      setLoadingIssues(true);
      try {
        const params = new URLSearchParams();
        if (user) params.set("username", user);
        if (q) params.set("q", q);
        if (diff) params.set("difficulty", diff);

        const res = await fetch(`/api/issues?${params.toString()}`, { signal });
        if (res.ok) {
          const data = await res.json();
          setIssues(data.issues ?? []);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
      } finally {
        setLoadingIssues(false);
      }
    },
    []
  );

  useEffect(() => {
    void fetchRepos();
  }, [fetchRepos]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchIssues(activeUsername, debouncedSearch, difficultyFilter, controller.signal);
    return () => controller.abort();
  }, [fetchIssues, activeUsername, debouncedSearch, difficultyFilter]);

  async function handleSyncProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!typedUsername.trim()) {
      setStatusMsg("Enter a GitHub username first.");
      return;
    }
    setSyncingProfile(true);
    setStatusMsg("");
    const customSkills = manualSkillInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          github_username: typedUsername.trim(),
          experience_level: level,
          manual_skills: customSkills,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatusMsg(data.error ?? "Failed to sync GitHub profile.");
        return;
      }
      setSkills(data.skills ?? []);
      setActiveUsername(typedUsername.trim());
      setStatusMsg(
        `Ranked verified issues for @${typedUsername.trim()}${data.cached ? " (24h cache)" : ""}.`
      );
    } finally {
      setSyncingProfile(false);
    }
  }

  async function handleAddRepo(e: React.FormEvent) {
    e.preventDefault();
    setStatusMsg("");
    const res = await fetch("/api/repos/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: newRepoInput }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatusMsg(data.error ?? "Use owner/repo format.");
      return;
    }
    setStatusMsg(`${data.queued} queued for the next 4-hour Go worker sync.`);
    setNewRepoInput("");
    void fetchRepos();
  }

  async function handleFeedback(issueId: number, type: "clicked" | "too_hard" | "dismissed") {
    const user = activeUsername || typedUsername.trim();
    if (!user) {
      if (type !== "clicked") {
        setStatusMsg("Sync your GitHub username on the left to record feedback.");
      }
      return;
    }
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, issue_id: issueId, feedback_type: type }),
    });
    if (res.ok) {
      if (type === "dismissed") {
        setIssues((prev) => prev.filter((i) => i.issue_id !== issueId));
      } else if (type === "too_hard") {
        setStatusMsg("Recorded feedback — recalibrating difficulty fit.");
        void fetchIssues(user, debouncedSearch, difficultyFilter);
      }
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#F7F4EC] text-[#000000]">
      {/* Near-Black Editorial Hero Band */}
      <header className="w-full bg-[#131313] text-[#F7F4EC]">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#F7F4EC]/20 px-5 py-5 md:px-10">
          <span className="text-[1.125rem] font-semibold leading-none tracking-[-0.02em]">
            FirstMerge
          </span>

          <nav className="flex items-center gap-6 text-[0.95rem] font-semibold">
            <button
              type="button"
              onClick={() => setActiveTab("issues")}
              className={`cursor-pointer pb-1 transition ${
                activeTab === "issues"
                  ? "border-b-2 border-[#F7F4EC] text-[#F7F4EC]"
                  : "text-[#F7F4EC]/60 hover:text-[#F7F4EC]"
              }`}
            >
              01 Issues ({issues.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("repos")}
              className={`cursor-pointer pb-1 transition ${
                activeTab === "repos"
                  ? "border-b-2 border-[#F7F4EC] text-[#F7F4EC]"
                  : "text-[#F7F4EC]/60 hover:text-[#F7F4EC]"
              }`}
            >
              02 Repo Health ({repos.length})
            </button>
          </nav>
        </div>

        <div className="grid grid-cols-1 gap-10 px-5 py-14 md:px-10 lg:grid-cols-[1.5fr_1fr] lg:items-end lg:py-20">
          <div>
            <p className="mb-4 text-[0.875rem] font-medium uppercase tracking-[0.06em] text-[#F7F4EC]/65">
              Unassigned · Zero Open PRs · Measured Maintainer Health
            </p>
            <h1 className="font-serif text-[2.75rem] font-normal leading-[1.02] tracking-[-0.02em] sm:text-[3.75rem]">
              Find open-source issues nobody has secretly claimed.
            </h1>
          </div>

          <div className="grid grid-cols-3 border-t border-[#F7F4EC]/25 pt-5 tabular-nums">
            <div>
              <div className="font-serif text-[2.25rem] leading-none">{repos.length}</div>
              <div className="mt-1.5 text-[0.75rem] font-medium uppercase tracking-[0.04em] text-[#F7F4EC]/65">
                Tracked Repos
              </div>
            </div>
            <div>
              <div className="font-serif text-[2.25rem] leading-none">{issues.length}</div>
              <div className="mt-1.5 text-[0.75rem] font-medium uppercase tracking-[0.04em] text-[#F7F4EC]/65">
                Clean Issues
              </div>
            </div>
            <div>
              <div className="font-serif text-[2.25rem] leading-none">4h</div>
              <div className="mt-1.5 text-[0.75rem] font-medium uppercase tracking-[0.04em] text-[#F7F4EC]/65">
                Go Sync Cycle
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Warm-Cream Editorial Two-Column Workspace */}
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[340px_1fr]">
        {/* Left Control Rail */}
        <aside className="border-b border-[#000000] bg-[#F7F4EC] p-5 md:p-8 lg:border-b-0 lg:border-r">
          <form onSubmit={handleSyncProfile} className="space-y-5">
            <div>
              <h2 className="font-serif text-[2rem] font-normal leading-none tracking-[-0.02em]">
                Skill Matcher
              </h2>
              <p className="mt-2 text-[0.875rem] font-medium leading-[1.4] text-[#4A4944]">
                Sync your public GitHub repositories to score every unassigned issue against your
                actual stack.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="gh-username"
                  className="mb-1.5 block text-[0.8rem] font-semibold uppercase tracking-[0.04em]"
                >
                  GitHub Username
                </label>
                <input
                  id="gh-username"
                  type="text"
                  value={typedUsername}
                  onChange={(e) => setTypedUsername(e.target.value)}
                  placeholder="e.g. torvalds"
                  className="w-full rounded-none border border-[#000000] bg-[#FFFDF8] px-3.5 py-3 text-[0.95rem] font-medium outline-none focus:bg-[#FFFFFF] focus:ring-2 focus:ring-[#000000]"
                />
              </div>

              <div>
                <label
                  htmlFor="exp-tier"
                  className="mb-1.5 block text-[0.8rem] font-semibold uppercase tracking-[0.04em]"
                >
                  Experience Tier
                </label>
                <select
                  id="exp-tier"
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                  className="w-full rounded-none border border-[#000000] bg-[#FFFDF8] px-3.5 py-3 text-[0.95rem] font-medium outline-none focus:ring-2 focus:ring-[#000000]"
                >
                  <option value="beginner">Beginner (Good First Issues)</option>
                  <option value="intermediate">Intermediate</option>
                  <option value="advanced">Advanced</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="extra-skills"
                  className="mb-1.5 block text-[0.8rem] font-semibold uppercase tracking-[0.04em]"
                >
                  Extra Stack (Optional)
                </label>
                <input
                  id="extra-skills"
                  type="text"
                  value={manualSkillInput}
                  onChange={(e) => setManualSkillInput(e.target.value)}
                  placeholder="typescript, go, postgresql"
                  className="w-full rounded-none border border-[#000000] bg-[#FFFDF8] px-3.5 py-3 text-[0.95rem] font-medium outline-none focus:bg-[#FFFFFF] focus:ring-2 focus:ring-[#000000]"
                />
              </div>

              <button
                type="submit"
                disabled={syncingProfile}
                className="w-full cursor-pointer rounded-none bg-[#000000] px-6 py-4 text-[1rem] font-semibold text-[#F7F4EC] transition hover:bg-[#131313]/85 disabled:opacity-50"
              >
                {syncingProfile ? "Analyzing GitHub..." : "Match My Stack"}
              </button>
            </div>

            {skills.length > 0 && (
              <div className="border-t border-[#000000] pt-5">
                <div className="mb-3 text-[0.8rem] font-semibold uppercase tracking-[0.04em]">
                  Detected Stack Weights
                </div>
                <div className="divide-y divide-[#000000]/20 border border-[#000000] bg-[#FFFDF8]">
                  {skills.slice(0, 8).map((s) => (
                    <div
                      key={s.skill}
                      className="flex items-center justify-between px-3 py-2 text-[0.875rem] font-semibold tabular-nums"
                    >
                      <span>{s.skill}</span>
                      <span>{Math.round(s.weight * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </form>

          <form onSubmit={handleAddRepo} className="mt-10 space-y-3 border-t border-[#000000] pt-8">
            <h3 className="font-serif text-[1.75rem] font-normal leading-none">Track Repository</h3>
            <p className="text-[0.875rem] font-medium text-[#4A4944]">
              Enqueue any public GitHub repo for GraphQL health scoring and issue ingestion.
            </p>
            <input
              type="text"
              value={newRepoInput}
              onChange={(e) => setNewRepoInput(e.target.value)}
              placeholder="owner/repo (e.g. vercel/next.js)"
              className="w-full rounded-none border border-[#000000] bg-[#FFFDF8] px-3.5 py-3 text-[0.95rem] font-medium outline-none focus:ring-2 focus:ring-[#000000]"
            />
            <button
              type="submit"
              className="w-full cursor-pointer rounded-none border border-[#000000] bg-transparent px-6 py-3.5 text-[0.95rem] font-semibold text-[#000000] transition hover:bg-[#000000] hover:text-[#F7F4EC]"
            >
              Queue for Sync
            </button>
          </form>
        </aside>

        {/* Right Editorial Content Stage */}
        <main className="p-5 md:p-10">
          {statusMsg && (
            <div className="mb-6 border border-[#000000] bg-[#131313] px-4 py-3 text-[0.9rem] font-semibold text-[#F7F4EC]">
              {statusMsg}
            </div>
          )}

          {activeTab === "issues" ? (
            <div>
              <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_210px]">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-[#000000]" />
                  <input
                    ref={searchRef}
                    type="text"
                    aria-label="Search open issues"
                    value={typedSearch}
                    onChange={(e) => setTypedSearch(e.target.value)}
                    placeholder='Full-text search issues (press "/" to focus)...'
                    className="w-full rounded-none border border-[#000000] bg-[#FFFDF8] py-3 pl-10 pr-4 text-[0.95rem] font-medium outline-none focus:ring-2 focus:ring-[#000000]"
                  />
                </div>
                <select
                  aria-label="Filter by difficulty"
                  value={difficultyFilter}
                  onChange={(e) => setDifficultyFilter(e.target.value)}
                  className="rounded-none border border-[#000000] bg-[#FFFDF8] px-3.5 py-3 text-[0.95rem] font-semibold outline-none focus:ring-2 focus:ring-[#000000]"
                >
                  <option value="">All Difficulties</option>
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </div>

              {loadingIssues ? (
                <div className="border-t border-[#000000] py-16 text-[1rem] font-semibold text-[#4A4944]">
                  Querying PostgreSQL tsvector index...
                </div>
              ) : issues.length === 0 ? (
                <div className="border-y border-[#000000] py-16">
                  <h3 className="font-serif text-[2.25rem] leading-tight">
                    No matching unassigned issues found.
                  </h3>
                  <p className="mt-2 text-[1rem] font-medium text-[#4A4944]">
                    Run the Go ingestion worker once (`go run ./cmd/worker --once`) to populate
                    starter repositories, or adjust your search filter and skill profile.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-[#000000] border-y border-[#000000]">
                  {issues.map((item) => (
                    <article
                      key={item.issue_id}
                      className="grid grid-cols-1 gap-6 py-8 md:grid-cols-[1fr_190px]"
                    >
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-3 text-[0.8rem] font-semibold uppercase tracking-[0.04em]">
                          <span>{item.repo_name}</span>
                          <span className="border border-[#000000] px-2 py-0.5 tabular-nums">
                            Health {item.repo_health}/100
                          </span>
                          <span className="border border-[#000000] bg-[#FFFDF8] px-2 py-0.5">
                            {item.difficulty}
                          </span>
                        </div>

                        <h3 className="font-serif text-[1.85rem] font-normal leading-[1.1] tracking-[-0.02em]">
                          <a
                            href={item.html_url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={() => handleFeedback(item.issue_id, "clicked")}
                            className="text-black no-underline transition-colors hover:text-[#075C43] hover:underline decoration-[#075C43] decoration-1 underline-offset-4"
                          >
                            <span className="font-sans text-[1rem] font-semibold text-[#4A4944]">
                              #{item.number}
                            </span>
                            <span>{item.title}</span>
                          </a>
                        </h3>

                        <p className="text-[0.875rem] font-semibold text-[#000000]">
                          {item.match_reason}
                        </p>

                        {item.body_excerpt && (
                          <p className="max-w-3xl text-[0.95rem] font-medium leading-[1.45] text-[#4A4944]">
                            {item.body_excerpt}
                          </p>
                        )}

                        <div className="flex flex-wrap gap-5 pt-1 text-[0.825rem] font-medium text-[#4A4944] tabular-nums">
                          <span>Language: {item.repo_language || "multi"}</span>
                          <span>Comments: {item.comment_count}</span>
                          <span>Opened: {item.created_at}</span>
                        </div>
                      </div>

                      <div className="flex flex-col justify-between gap-4">
                        <div className="bg-[#131313] p-4 text-[#F7F4EC] tabular-nums">
                          <div className="text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-[#F7F4EC]/65">
                            Match Fit
                          </div>
                          <div className="mt-1 font-serif text-[2.5rem] leading-none">
                            {item.match_score}%
                          </div>
                        </div>

                        <div className="flex flex-col gap-2">
                          <a
                            href={item.html_url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={() => handleFeedback(item.issue_id, "clicked")}
                            className="flex w-full items-center justify-center gap-1.5 rounded-none bg-[#000000] px-4 py-3 text-[0.875rem] font-semibold text-[#F7F4EC] transition hover:bg-[#131313]/85"
                          >
                            Open Issue
                            <ArrowUpRight className="h-4 w-4" />
                          </a>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => handleFeedback(item.issue_id, "too_hard")}
                              className="cursor-pointer rounded-none border border-[#000000] bg-transparent py-2 text-[0.75rem] font-semibold transition hover:bg-[#000000] hover:text-[#F7F4EC]"
                            >
                              Too Hard
                            </button>
                            <button
                              type="button"
                              onClick={() => handleFeedback(item.issue_id, "dismissed")}
                              className="cursor-pointer rounded-none border border-[#000000] bg-transparent py-2 text-[0.75rem] font-semibold transition hover:bg-[#000000] hover:text-[#F7F4EC]"
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="divide-y divide-[#000000] border-y border-[#000000]">
              {repos.map((r) => (
                <article
                  key={r.full_name}
                  className="grid grid-cols-1 gap-8 py-9 md:grid-cols-[1fr_240px]"
                >
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-3 text-[0.8rem] font-semibold uppercase tracking-[0.04em]">
                      <span>{r.language || "multi-language"}</span>
                      <span>·</span>
                      <span className="tabular-nums">{r.stars.toLocaleString()} Stars</span>
                      <span>·</span>
                      <span className="tabular-nums">{r.open_issues} Open Issues</span>
                    </div>

                    <h3 className="font-serif text-[2.5rem] font-normal leading-[1.02] tracking-[-0.02em]">
                      <a
                        href={`https://github.com/${r.full_name}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-[#0000EE] hover:underline"
                      >
                        {r.full_name}
                      </a>
                    </h3>

                    <p className="max-w-2xl text-[1rem] font-medium leading-[1.45] text-[#4A4944]">
                      {r.description || "Active open-source repository tracked by FirstMerge."}
                    </p>

                    <div className="grid grid-cols-1 gap-3 border-t border-[#000000]/20 pt-4 text-[0.875rem] font-semibold sm:grid-cols-3 tabular-nums">
                      <div>
                        <span className="block text-[0.75rem] uppercase text-[#4A4944]">
                          Maintainer Reply
                        </span>
                        {r.responsiveness !== null ? `${r.responsiveness} / 100` : "N/A"}
                      </div>
                      <div>
                        <span className="block text-[0.75rem] uppercase text-[#4A4944]">
                          External PR Merge
                        </span>
                        {r.merge_rate !== null ? `${r.merge_rate} / 100` : "N/A"}
                      </div>
                      <div>
                        <span className="block text-[0.75rem] uppercase text-[#4A4944]">
                          Last Synced
                        </span>
                        {r.last_synced_at}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col justify-between bg-[#131313] p-6 text-[#F7F4EC]">
                    <div>
                      <span className="text-[0.75rem] font-semibold uppercase tracking-[0.06em] text-[#F7F4EC]/65">
                        GraphQL Health Index
                      </span>
                      <div className="mt-2 font-serif text-[4rem] leading-none tabular-nums">
                        {r.health_score}
                        <span className="text-[1.5rem] text-[#F7F4EC]/60">/100</span>
                      </div>
                    </div>
                    <a
                      href={`https://github.com/${r.full_name}/issues`}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-6 inline-flex items-center justify-between border border-[#F7F4EC] px-4 py-2.5 text-[0.85rem] font-semibold text-[#F7F4EC] transition hover:bg-[#F7F4EC] hover:text-[#131313]"
                    >
                      <span>Browse GitHub</span>
                      <ArrowUpRight className="h-4 w-4" />
                    </a>
                  </div>
                </article>
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Signature Near-Black Editorial Footer with Massive Condensed Wordmark */}
      <footer className="mt-20 w-full bg-[#131313] px-5 pt-16 pb-8 text-[#F7F4EC] md:px-10">
        <div className="grid grid-cols-1 gap-12 border-b border-[#F7F4EC]/20 pb-16 md:grid-cols-2">
          <div className="space-y-4">
            <div className="text-[0.8rem] font-semibold uppercase tracking-[0.06em] text-[#F7F4EC]/60">
              Directory Navigation
            </div>
            <div className="flex flex-col items-start gap-2 text-[1.125rem] font-semibold">
              <button
                type="button"
                onClick={() => setActiveTab("issues")}
                className="cursor-pointer hover:underline"
              >
                Matched Unassigned Issues
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("repos")}
                className="cursor-pointer hover:underline"
              >
                Maintainer Health Directory
              </button>
            </div>
            <p className="max-w-md pt-2 text-[0.875rem] font-medium leading-[1.5] text-[#F7F4EC]/70">
              Powered by PostgreSQL generated tsvector full-text search, GraphQL v4 maintainer
              metrics, and a concurrent Go ingestion worker.
            </p>
          </div>

          <form
            onSubmit={handleAddRepo}
            className="space-y-3 md:w-full md:max-w-md md:justify-self-end"
          >
            <div className="text-[0.8rem] font-semibold uppercase tracking-[0.06em] text-[#F7F4EC]/60">
              Submit an Open-Source Repo
            </div>
            <div className="flex">
              <input
                type="text"
                value={newRepoInput}
                onChange={(e) => setNewRepoInput(e.target.value)}
                placeholder="owner/repository"
                className="w-full rounded-none border border-[#F7F4EC] bg-[#F7F4EC] px-4 py-3 text-[0.95rem] font-medium text-[#000000] outline-none"
              />
              <button
                type="submit"
                className="shrink-0 cursor-pointer rounded-none border border-[#F7F4EC] bg-[#000000] px-6 py-3 text-[0.95rem] font-semibold text-[#F7F4EC] transition hover:bg-[#F7F4EC] hover:text-[#000000]"
              >
                Queue
              </button>
            </div>
          </form>
        </div>

        <div className="pt-8">

 <div
    aria-label="FirstMerge"
    className="w-full select-none pt-6 pb-3 text-center text-[clamp(4rem,16vw,14rem)] font-semibold leading-[1.08] tracking-[-0.04em] text-[#F7F4EC]"
>
    FirstMerge
     </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-[0.8rem] font-medium text-[#F7F4EC]/60">
            <span>PostgreSQL + Go + Next.js</span>
          <span>© 2026 FirstMerge</span>
          </div>
        </div>
      </footer>
    </div>
  );
}