#!/usr/bin/env bash
# Re-vendor magpie's internal/claudetui (MIT) at a given checkout, apply our renames and patches, build and test.
#   ./sync.sh <path-to-magpie-checkout>
# Leaves internal/claudetui = upstream + rename.sed + patches/*.patch, records the upstream commit in UPSTREAM.
set -euo pipefail
cd "$(dirname "$0")"
SRC=${1:?path to a magpie checkout}
COMMIT=$(git -C "$SRC" rev-parse HEAD)
DATE=$(git -C "$SRC" show -s --format=%ci HEAD)
rm -rf internal/claudetui
cp -r "$SRC/internal/claudetui" internal/claudetui
cp "$SRC/LICENSE" LICENSE.magpie
# renames: every text file (Go, JS); testdata is binary screen captures and is left alone
find internal/claudetui -type f \( -name '*.go' -o -name '*.js' \) -exec sed -i -E -f rename.sed {} +
for p in patches/*.patch; do
  echo "applying $p"
  patch -p1 --no-backup-if-mismatch < "$p"
done
printf 'upstream: https://github.com/yetone/magpie\ncommit: %s\ndate: %s\npath: internal/claudetui\nsynced: %s\n' "$COMMIT" "$DATE" "$(date -u +%FT%TZ)" > UPSTREAM
echo "synced claudetui at $COMMIT"

# ---- build: a static Linux amd64 binary the console hands to nodes (apps/console/src/node/deploy.ts SHIM_SOURCE) ----
export GOFLAGS=-mod=mod GOTOOLCHAIN=local CGO_ENABLED=0
GO=${GO:-$(command -v go || echo /root/.local/go/bin/go)}
mkdir -p dist
VERSION=$(date -u +%Y%m%d).${COMMIT:0:7}
"$GO" vet ./... 
GOOS=linux GOARCH=amd64 "$GO" build -trimpath -ldflags "-s -w -X main.version=$VERSION -X main.upstream=${COMMIT:0:7}" -o dist/cc-tui-shim ./cmd/cc-tui-shim
sha256sum dist/cc-tui-shim | tee dist/cc-tui-shim.sha256
echo "built dist/cc-tui-shim ($VERSION); run the upstream tests on a machine with a pty: go test ./internal/claudetui/ (TestShimInWSL is expected to fail: WSL is stubbed out)"
