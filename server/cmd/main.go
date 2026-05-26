package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/naston/astrolabe-insights-hub/server/api"
)

func main() {
	aimURL := flag.String("aim-url", "http://127.0.0.1:43802", "Aim REST API base URL")
	addr := flag.String("addr", "0.0.0.0:43801", "Listen address for the dashboard")
	colorsFile := flag.String("colors", "", "Path to colors.json (default: config/colors.json next to binary)")
	staticDir := flag.String("static", "", "Path to static files directory (default: static/ next to binary)")
	stateDir := flag.String("state-dir", "", "Path to astrolabe state directory (default: ~/.astrolabe/state)")
	flag.Parse()

	// Resolve paths relative to the binary location
	execDir := executableDir()

	if *colorsFile == "" {
		*colorsFile = filepath.Join(execDir, "config", "colors.json")
	}
	if *staticDir == "" {
		*staticDir = filepath.Join(execDir, "static")
	}

	// Load color palette
	colors, err := loadColors(*colorsFile)
	if err != nil {
		log.Printf("Warning: could not load colors from %s: %v (using defaults)", *colorsFile, err)
		colors = defaultColors()
	}

	// Resolve state dir
	if *stateDir == "" {
		home, _ := os.UserHomeDir()
		*stateDir = filepath.Join(home, ".astrolabe", "state")
	}

	// Create Aim client, state reader, and handler
	aimClient := api.NewAimClient(*aimURL)
	stateReader := api.NewStateReader(*stateDir)
	handler := api.NewHandler(aimClient, stateReader, colors)

	// Response caches. TTLs and bounds chosen per plans/dashboard-scaling.md:
	//   - 2s on state-shaped endpoints (experiments list + per-experiment
	//     runs list). Invisible relative to the 3s frontend poll cadence;
	//     ~8.5× aim-api load reduction at 50 polling tabs. Unbounded —
	//     the key space is small (single entry / one per experiment).
	//   - 10s on metric series. Larger payloads, slower-changing, idle
	//     during eval pauses. Bounded LRU at 1000 entries (≈30 MB worst
	//     case at ~30 KB per metric series) so a long-running NUC with
	//     many experiments × many metrics can't OOM the dashboard.
	experimentsCache := api.NewTTLCache(2*time.Second, 0)
	experimentRunsCache := api.NewTTLCache(2*time.Second, 0)
	metricSeriesCache := api.NewTTLCache(10*time.Second, 1000)
	cachedMetricData := metricSeriesCache.Middleware(handler.HandleMetricData)
	cachedExperimentRuns := experimentRunsCache.Middleware(handler.HandleExperimentRuns)

	// API routes
	mux := http.NewServeMux()
	mux.HandleFunc("/api/runs", handler.HandleRuns)
	mux.HandleFunc("/api/runs/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/info"):
			handler.HandleRunInfo(w, r)
		case strings.Contains(path, "/metrics/"):
			cachedMetricData(w, r)
		case strings.HasSuffix(path, "/metrics"):
			handler.HandleRunMetrics(w, r)
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/api/experiments", experimentsCache.Middleware(handler.HandleExperiments))
	mux.HandleFunc("/api/experiments/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/includes"):
			handler.HandleExperimentIncludes(w, r)
		case strings.HasSuffix(path, "/runs"):
			cachedExperimentRuns(w, r)
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/api/config/colors", handler.HandleColors)
	mux.HandleFunc("/api/health", handler.HandleHealth)

	// Static files with SPA fallback. TanStack Router does client-side
	// routing — paths like /experiment?name=foo don't exist as files
	// on disk, so a plain http.FileServer 404s on direct navigation
	// (e.g. browser refresh on the experiment page, or following a
	// link from Linear). Wrap the file server: if the requested path
	// doesn't resolve to a real file, serve index.html and let
	// client-side routing take over.
	fileServer := http.FileServer(http.Dir(*staticDir))
	mux.Handle("/", spaFallback(*staticDir, fileServer))

	log.Printf("Astrolabe dashboard starting on %s", *addr)
	log.Printf("  Aim API: %s", *aimURL)
	log.Printf("  Static:  %s", *staticDir)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatal(err)
	}
}

// spaFallback serves staticDir/index.html for any path that isn't an
// API route and doesn't resolve to a real file. Required for SPA-style
// client-side routing (TanStack Router) to handle deep links — without
// this, refreshing /experiment 404s because there's no /experiment file
// in the dist.
func spaFallback(staticDir string, fileServer http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// API routes are registered separately and never hit this
		// handler. Anything that does is either a static asset or a
		// SPA route.
		path := r.URL.Path
		if path == "/" {
			fileServer.ServeHTTP(w, r)
			return
		}
		// Try to stat the file the URL would resolve to. http.FileServer
		// joins the URL path against the static dir; replicate that
		// here for the existence check.
		filePath := filepath.Join(staticDir, filepath.FromSlash(path))
		info, err := os.Stat(filePath)
		if err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		// Path doesn't resolve to a file — serve index.html so the
		// SPA can route. The browser receives the same HTML for
		// /experiment as for /, and TanStack Router takes over.
		http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
	})
}

func executableDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

func loadColors(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg struct {
		Palette []string `json:"palette"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	if len(cfg.Palette) == 0 {
		return nil, fmt.Errorf("empty palette in %s", path)
	}
	return cfg.Palette, nil
}

func defaultColors() []string {
	return []string{
		"#4E79A7", "#F28E2B", "#E15759", "#76B7B2",
		"#59A14F", "#EDC948", "#B07AA1", "#FF9DA7",
		"#9C755F", "#BAB0AC", "#AF7AA1", "#5FA2CE",
		"#FC7D0B", "#A3ACB9", "#D37295", "#FABFD2",
		"#B6992D", "#499894", "#86BCB6", "#F1CE63",
	}
}
