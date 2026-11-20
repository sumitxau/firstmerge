FirstMerge

Open-source issue discovery engine and maintainer health index built with **Next.js App Router (`pnpm`)**, a **Go concurrent batch ingestion worker**, and **Neon PostgreSQL**.

## How It Works
1. **Go Ingestion Worker (`worker/`)**: Runs on Render Free Tier and wakes every 4 hours via `cron-job.org` (`POST /internal/sync`). Uses `FOR UPDATE SKIP LOCKED` across 2 goroutines, fetches maintainer responsiveness and outside PR merge rates via **GitHub GraphQL v4**, syncs issues with **REST `ETag` `304 Not Modified`**, and filters out issues claimed in comments or linked to an open PR via `/timeline`.
2. **Next.js Web + API (`frontend/`)**: Runs on Netlify Free Tier with zero cold starts, querying Neon PostgreSQL's stored `TSVECTOR` + `GIN` index and ranking issues against the user's real GitHub stack.

## Local Run
1. Fill in `frontend/.env.local` with `DATABASE_URL` and `GH_API_TOKEN`.
2. Ingest starter repositories once:
   ```powershell
   cd worker
   $env:DATABASE_URL="your_neon_url"
   $env:GH_API_TOKEN="your_github_token"
   go run ./cmd/worker --once
   ```
3. Start the Next.js app:
   ```powershell
   cd ../frontend
   pnpm dev
   ```
