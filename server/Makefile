# Astrolabe Dashboard server (Go API + binary).
#
# Local-dev targets only. The release flow lives in
# .github/workflows/release.yml — that's what publishes the binary +
# wheel to GitHub releases when a tag is pushed.

BINARY = astrolabe-dashboard
CMD = ./cmd
CONFIG = ./config
# Static lives at the repo root after `bun run build` writes to dist/.
STATIC = ../dist

.PHONY: build
build:
	go build -o $(BINARY) $(CMD)

.PHONY: build-linux
build-linux:
	GOOS=linux GOARCH=amd64 go build -o $(BINARY)-linux-amd64 $(CMD)

.PHONY: test
test:
	go test ./...

# Run locally (assumes Aim API on :43802 and a built dist/ at repo root).
.PHONY: run
run: build
	./$(BINARY) --aim-url http://127.0.0.1:43802 --addr 127.0.0.1:43801 --colors $(CONFIG)/colors.json --static $(STATIC)

.PHONY: clean
clean:
	rm -f $(BINARY) $(BINARY)-linux-amd64
