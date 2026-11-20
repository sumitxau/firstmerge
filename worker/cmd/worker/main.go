package main

import (
	"context"
	"encoding/json"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/sumitxau/firstmerge/worker/internal/core"
)

func main() {
	runOnce := flag.Bool("once", false, "Drain job queue once and exit")
	flag.Parse()

	if core.GitHubToken() == "" {
		slog.Error("GH_API_TOKEN (or GITHUB_TOKEN) is required for GraphQL health and ETag 304 sync")
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := core.InitDB(ctx); err != nil {
		slog.Error("init db failed", "err", err)
		os.Exit(1)
	}
	defer core.DB.Close()

	// Mode 1: One-shot local CLI run
	if *runOnce {
		slog.Info("running one-shot Go ingestion worker (2 goroutines)")
		if err := core.RunWorkerPool(ctx, 2); err != nil {
			slog.Error("worker failed", "err", err)
			os.Exit(1)
		}
		slog.Info("queue drained; exiting cleanly")
		return
	}

	// Mode 2: Render Native Go HTTP Cron Trigger (invoked by cron-job.org every 4 hours)
	workerSecret := os.Getenv("WORKER_SECRET")
	if workerSecret == "" {
		slog.Error("WORKER_SECRET is required in HTTP trigger mode")
		os.Exit(1)
	}

	var syncing atomic.Bool
	var mu sync.RWMutex
	lastRunAt := "never"

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		mu.RLock()
		lr := lastRunAt
		mu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":   "ok",
			"syncing":  syncing.Load(),
			"last_run": lr,
		})
	})

	mux.HandleFunc("POST /internal/sync", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Worker-Secret") != workerSecret {
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
			return
		}
		if !syncing.CompareAndSwap(false, true) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"status":"already_running"}`))
			return
		}

		go func() {
			defer syncing.Store(false)
			runCtx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
			defer cancel()

			slog.Info("cron trigger received; starting 2-goroutine worker pool")
			if err := core.RunWorkerPool(runCtx, 2); err != nil {
				slog.Error("worker pool error", "err", err)
			}
			mu.Lock()
			lastRunAt = time.Now().UTC().Format(time.RFC3339)
			mu.Unlock()
			slog.Info("scheduled sync completed cleanly")
		}()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"started"}`))
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      15 * time.Second,
	}

	go func() {
		slog.Info("FirstMerge Go Worker HTTP trigger listening", "port", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}
