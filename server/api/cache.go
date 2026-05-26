package api

// In-process response cache for the read-only dashboard endpoints.
//
// Why this exists: at one user with one polling tab the dashboard is fine,
// but every poll fans out into ~3-5 Aim REST calls (list experiments,
// list runs per experiment, fetch params per run, metric series). At
// N concurrent polling tabs that traffic multiplies linearly into the
// Aim REST API's small uvicorn worker pool, queues build, and slow
// responses trigger the polling race in the frontend hook.
//
// Caching here cuts the multiplication factor. Since every user sees the
// same /api/experiments payload, a 2s TTL means at most one aim-api round
// trip per 2 seconds regardless of how many tabs are polling. The
// freshness loss is invisible relative to the 3s poll cadence.
//
// Cache key is the request URI (path + raw query). TTL is per cache
// instance — we run one cache per endpoint family with its own TTL
// (short for state-shaped endpoints, longer for metric series which
// change less frequently and have larger payloads). The metric series
// cache is bounded LRU since its key cardinality (run_hash × metric_name)
// can grow without bound; the others are unbounded since their key
// cardinality is small.
//
// Invalidation: TTL-only. FSM state transitions happen on a slower
// cadence than our TTL, so a stale read is at worst N seconds behind
// reality — far smaller than the polling interval. No explicit
// invalidation API is needed; if a use case eventually needs one
// (e.g., post-write read-your-writes from the dashboard itself), add
// it then.

import (
	"bytes"
	"container/list"
	"net/http"
	"sync"
	"time"
)

// TTLCache is a thread-safe key→bytes cache with per-entry expiry and
// an optional max-size bound. When maxSize is 0 the cache is unbounded;
// when >0 the cache evicts the least-recently-used entry on insert
// once size exceeds the bound.
//
// We don't use a third-party LRU library because we want a single-file
// implementation that's auditable in code review and doesn't add a
// dependency. The maxSize codepath is ~30 LOC of `container/list`.
type TTLCache struct {
	ttl     time.Duration
	maxSize int // 0 = unbounded

	mu      sync.Mutex
	entries map[string]*list.Element
	order   *list.List // front = most recently used

	// now is injected so tests can advance time without sleeping.
	// Production callers leave it nil → defaults to time.Now in get/set.
	now func() time.Time
}

type ttlEntry struct {
	key       string
	body      []byte
	expiresAt time.Time
}

// NewTTLCache returns a cache with the given expiry and optional max
// size. maxSize == 0 means unbounded; >0 enables LRU eviction past the
// bound.
func NewTTLCache(ttl time.Duration, maxSize int) *TTLCache {
	return &TTLCache{
		ttl:     ttl,
		maxSize: maxSize,
		entries: make(map[string]*list.Element),
		order:   list.New(),
	}
}

func (c *TTLCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// Get returns the cached body and true on hit, nil and false on miss
// or expired entry. Expired entries are evicted on access.
func (c *TTLCache) Get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	elem, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	entry := elem.Value.(*ttlEntry)
	if c.clock().After(entry.expiresAt) {
		c.order.Remove(elem)
		delete(c.entries, key)
		return nil, false
	}
	// LRU bump on hit (only matters when maxSize > 0, but cheap either way)
	c.order.MoveToFront(elem)
	return entry.body, true
}

// Set inserts or replaces a cache entry. Evicts the LRU entry if the
// insert pushes us past maxSize.
func (c *TTLCache) Set(key string, body []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	expiresAt := c.clock().Add(c.ttl)
	if elem, ok := c.entries[key]; ok {
		entry := elem.Value.(*ttlEntry)
		entry.body = body
		entry.expiresAt = expiresAt
		c.order.MoveToFront(elem)
		return
	}
	entry := &ttlEntry{key: key, body: body, expiresAt: expiresAt}
	c.entries[key] = c.order.PushFront(entry)
	if c.maxSize > 0 && c.order.Len() > c.maxSize {
		oldest := c.order.Back()
		if oldest != nil {
			delete(c.entries, oldest.Value.(*ttlEntry).key)
			c.order.Remove(oldest)
		}
	}
}

// Len returns the number of live entries (including possibly-expired
// ones — expiry is checked lazily on Get).
func (c *TTLCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// recorder captures the handler's response so we can both serve it to
// the original client AND store it in the cache. Writes are doubled
// (buffer + underlying ResponseWriter) on the cache-miss path; on the
// cache-hit path the handler is bypassed entirely.
type recorder struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
	// wroteHeader tracks whether the handler called WriteHeader so we
	// don't double-set the status code.
	wroteHeader bool
}

func (r *recorder) WriteHeader(code int) {
	if r.wroteHeader {
		return
	}
	r.wroteHeader = true
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(p []byte) (int, error) {
	if !r.wroteHeader {
		// Implicit 200 — match net/http's behavior.
		r.status = http.StatusOK
		r.wroteHeader = true
	}
	r.body.Write(p)
	return r.ResponseWriter.Write(p)
}

// Middleware wraps a handler so its response is cached. Only 2xx
// responses are stored — 4xx/5xx pass through to the client unmodified
// so transient backend failures don't get pinned in the cache for the
// TTL window.
//
// On cache hit the wrapped handler is NOT invoked; the cached bytes
// are written directly with Content-Type: application/json (every
// dashboard endpoint we cache returns JSON). The X-Cache header lets
// us distinguish hits from misses in dev tools or load tests.
func (c *TTLCache) Middleware(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Only cache GET. POST/PUT/DELETE never hit these handlers today,
		// but the guard is cheap insurance against future endpoints.
		if r.Method != http.MethodGet {
			h(w, r)
			return
		}
		key := r.URL.RequestURI()
		if body, ok := c.Get(key); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Cache", "hit")
			w.Write(body)
			return
		}
		rec := &recorder{ResponseWriter: w}
		w.Header().Set("X-Cache", "miss")
		h(rec, r)
		if rec.status >= 200 && rec.status < 300 {
			c.Set(key, rec.body.Bytes())
		}
	}
}
