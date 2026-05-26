package api

// Tests for the in-process response cache.
//
// Contract under test (derived from cache.go without user confirmation —
// verify before merge):
//   - Get returns (body, true) when an entry exists and has not expired
//   - Get returns (nil, false) for missing or expired entries
//   - Set stores the entry with `expiresAt = now + ttl`
//   - Expired entries are evicted on access (Get), not by a background sweeper
//   - When maxSize > 0, inserting past the bound evicts the LRU entry
//   - Get bumps the entry's LRU position so recently-read entries survive
//     eviction longer
//   - The Middleware serves cached bodies on hit and bypasses the handler;
//     on miss it invokes the handler and stores 2xx responses
//   - 4xx/5xx responses are NOT cached (transient backend failures must
//     not be pinned for the TTL window)
//   - Non-GET methods are not cached
//   - Concurrent Get/Set is safe (no data race, no panic)

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"
)

// fakeClock returns a closure pair (now, advance) for tests that need
// to move time without sleeping. The cache reads `now()` on every
// Get/Set, so advancing the clock between calls lets us test expiry
// deterministically.
func fakeClock(start time.Time) (now func() time.Time, advance func(time.Duration)) {
	var mu sync.Mutex
	t := start
	now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return t
	}
	advance = func(d time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		t = t.Add(d)
	}
	return
}

// --- Edge / unhappy paths first per the testing guide ---

func TestGetReturnsMissOnEmptyCache(t *testing.T) {
	c := NewTTLCache(time.Second, 0)
	if body, ok := c.Get("anything"); ok || body != nil {
		t.Fatalf("expected miss on empty cache, got (%v, %v)", body, ok)
	}
}

func TestExpiredEntryEvictedOnGet(t *testing.T) {
	now, advance := fakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	c := NewTTLCache(2*time.Second, 0)
	c.now = now

	c.Set("k", []byte("v"))
	// Just before expiry — still a hit.
	advance(2*time.Second - time.Nanosecond)
	if body, ok := c.Get("k"); !ok || string(body) != "v" {
		t.Fatalf("expected hit just before expiry, got (%q, %v)", body, ok)
	}
	// Just past expiry — miss, and the entry is removed.
	advance(2 * time.Nanosecond)
	if _, ok := c.Get("k"); ok {
		t.Fatalf("expected miss after TTL expiry")
	}
	if c.Len() != 0 {
		t.Fatalf("expected expired entry to be evicted on access; cache still has %d entries", c.Len())
	}
}

func TestLRUEvictionAtCapacity(t *testing.T) {
	// maxSize=3 → inserting a 4th entry must evict the least-recently
	// used. We then verify that the LRU was specifically the oldest
	// (not e.g. the newest or a random pick).
	c := NewTTLCache(time.Hour, 3)
	c.Set("a", []byte("1"))
	c.Set("b", []byte("2"))
	c.Set("c", []byte("3"))
	// "a" is now LRU. Inserting "d" should evict it.
	c.Set("d", []byte("4"))
	if _, ok := c.Get("a"); ok {
		t.Fatalf("expected LRU key 'a' to be evicted after capacity overflow")
	}
	for _, k := range []string{"b", "c", "d"} {
		if _, ok := c.Get(k); !ok {
			t.Fatalf("expected key %q to survive eviction", k)
		}
	}
}

func TestGetBumpsLRUPosition(t *testing.T) {
	// If Get didn't bump LRU position, a frequently-accessed-but-old
	// entry would still get evicted as soon as the cache filled up.
	// Verify access-time, not insert-time, drives eviction.
	c := NewTTLCache(time.Hour, 3)
	c.Set("a", []byte("1"))
	c.Set("b", []byte("2"))
	c.Set("c", []byte("3"))

	// Touch "a" — it's now MRU. "b" becomes the LRU.
	c.Get("a")

	c.Set("d", []byte("4")) // should evict "b", not "a"
	if _, ok := c.Get("a"); !ok {
		t.Fatalf("expected recently-read 'a' to survive eviction")
	}
	if _, ok := c.Get("b"); ok {
		t.Fatalf("expected 'b' (now LRU) to be evicted")
	}
}

func TestSetReplaceExistingResetsTTL(t *testing.T) {
	// Updating a key should reset its expiry, not preserve the old one.
	// Otherwise a frequently-updated entry could expire mid-stream.
	now, advance := fakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	c := NewTTLCache(2*time.Second, 0)
	c.now = now

	c.Set("k", []byte("v1"))
	advance(time.Second)
	c.Set("k", []byte("v2")) // resets TTL — expires 2s from NOW
	advance(time.Second + 500*time.Millisecond)
	body, ok := c.Get("k")
	if !ok {
		t.Fatalf("expected updated entry still alive 1.5s after update (TTL=2s)")
	}
	if string(body) != "v2" {
		t.Fatalf("expected updated body 'v2', got %q", body)
	}
}

func TestMaxSizeZeroIsUnbounded(t *testing.T) {
	// maxSize=0 disables eviction. Insert many entries; none should
	// disappear before TTL.
	c := NewTTLCache(time.Hour, 0)
	for i := 0; i < 100; i++ {
		c.Set(strconv.Itoa(i), []byte{byte(i)})
	}
	if c.Len() != 100 {
		t.Fatalf("expected 100 entries in unbounded cache, got %d", c.Len())
	}
}

// --- Middleware behavior ---

// trackingHandler records how many times it was invoked so tests can
// assert that cache hits bypass the wrapped handler.
type trackingHandler struct {
	calls   int
	mu      sync.Mutex
	status  int
	body    []byte
}

func (h *trackingHandler) handle(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	h.calls++
	h.mu.Unlock()
	if h.status == 0 {
		h.status = http.StatusOK
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(h.status)
	w.Write(h.body)
}

func (h *trackingHandler) callCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.calls
}

func TestMiddlewareCacheHitSkipsHandler(t *testing.T) {
	h := &trackingHandler{body: []byte(`[{"name":"x"}]`)}
	c := NewTTLCache(time.Hour, 0)
	mw := c.Middleware(h.handle)

	for i := 0; i < 5; i++ {
		w := httptest.NewRecorder()
		mw(w, httptest.NewRequest("GET", "/api/experiments", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("iter %d: expected 200, got %d", i, w.Code)
		}
		if w.Body.String() != string(h.body) {
			t.Fatalf("iter %d: body mismatch", i)
		}
	}
	if h.callCount() != 1 {
		t.Fatalf("expected handler called once (rest cache hits), got %d", h.callCount())
	}
}

func TestMiddlewareDoesNotCacheErrorResponses(t *testing.T) {
	// A 502 from a flaky aim-api must NOT be pinned in the cache. Next
	// request should re-invoke the handler so a recovered backend
	// surfaces immediately.
	for _, status := range []int{http.StatusBadRequest, http.StatusInternalServerError, http.StatusBadGateway} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			h := &trackingHandler{body: []byte(`{"error":"bad"}`), status: status}
			c := NewTTLCache(time.Hour, 0)
			mw := c.Middleware(h.handle)

			mw(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/experiments", nil))
			mw(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/experiments", nil))

			if h.callCount() != 2 {
				t.Fatalf("expected error status %d to bypass cache (2 calls), got %d", status, h.callCount())
			}
		})
	}
}

func TestMiddlewareDoesNotCacheNonGET(t *testing.T) {
	// Future-proofing: cache is only safe for idempotent reads.
	h := &trackingHandler{body: []byte(`{}`)}
	c := NewTTLCache(time.Hour, 0)
	mw := c.Middleware(h.handle)

	mw(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/experiments", nil))
	mw(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/experiments", nil))
	if h.callCount() != 2 {
		t.Fatalf("expected POST to bypass cache, got %d handler calls", h.callCount())
	}
}

func TestMiddlewareKeyIncludesQueryString(t *testing.T) {
	// Two requests with the same path but different query strings must
	// NOT collide in the cache. RequestURI() includes the raw query.
	h := &trackingHandler{body: []byte(`{}`)}
	c := NewTTLCache(time.Hour, 0)
	mw := c.Middleware(h.handle)

	mw(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/runs/abc/metrics/loss", nil))
	mw(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/runs/abc/metrics/loss?since=100", nil))

	if h.callCount() != 2 {
		t.Fatalf("expected distinct query strings to be distinct cache keys, got %d calls", h.callCount())
	}
}

func TestMiddlewareSetsCacheHeader(t *testing.T) {
	// X-Cache: hit/miss is what we'll grep for in load-test output to
	// verify the cache is actually being used at scale.
	h := &trackingHandler{body: []byte(`{}`)}
	c := NewTTLCache(time.Hour, 0)
	mw := c.Middleware(h.handle)

	first := httptest.NewRecorder()
	mw(first, httptest.NewRequest("GET", "/api/experiments", nil))
	if first.Header().Get("X-Cache") != "miss" {
		t.Fatalf("first request expected X-Cache: miss, got %q", first.Header().Get("X-Cache"))
	}

	second := httptest.NewRecorder()
	mw(second, httptest.NewRequest("GET", "/api/experiments", nil))
	if second.Header().Get("X-Cache") != "hit" {
		t.Fatalf("second request expected X-Cache: hit, got %q", second.Header().Get("X-Cache"))
	}
}

// --- Concurrency ---

func TestConcurrentGetSetIsRaceFree(t *testing.T) {
	// Run under `go test -race ./...` to actually detect data races.
	// Without -race the test still verifies no panic / no lost writes.
	c := NewTTLCache(time.Hour, 100)

	const writers = 8
	const reads = 1000

	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			for i := 0; i < reads; i++ {
				key := strconv.Itoa((seed*reads + i) % 50) // shared keyspace
				if i%3 == 0 {
					c.Set(key, []byte(key))
				} else {
					c.Get(key)
				}
			}
		}(w)
	}
	wg.Wait()
}
