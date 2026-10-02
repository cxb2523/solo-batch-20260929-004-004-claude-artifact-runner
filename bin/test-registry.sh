#!/usr/bin/env bash
# Acceptance tests for the artifact registry management page.
#
# 1. Builds the app (npm run build)
# 2. Bundles the pure registry logic with esbuild and runs it under Node
#
# The script is POSIX-compatible (it also runs under dash).

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { printf '%b[info]%b %s\n'  "$YELLOW" "$NC" "$1"; }
ok()    { printf '%b[pass]%b %s\n'  "$GREEN" "$NC" "$1"; }
fail()  { printf '%b[fail]%b %s\n'  "$RED" "$NC" "$1" 1>&2; }

command -v node >/dev/null 2>&1 || { fail "node is required"; exit 1; }
command -v npm  >/dev/null 2>&1 || { fail "npm is required"; exit 1; }

if [ ! -f package.json ]; then
  fail "must be run from the project root (package.json not found)"
  exit 1
fi

if [ ! -f src/artifacts/index.tsx ] || [ ! -f src/lib/slugify.ts ]; then
  fail "registry page or src/lib/slugify.ts is missing"
  exit 1
fi

info "1/3 production build (npm run build)"
npm run build
ok "production build succeeded"

TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t registry-tests)
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
BUNDLE="$TMP_DIR/registry-tests.mjs"
E2E_BUNDLE="$TMP_DIR/registry-e2e.mjs"

info "2/3 bundling registry logic tests with esbuild"
ESBUILD_BIN="node_modules/esbuild/bin/esbuild"
if [ ! -f "$ESBUILD_BIN" ]; then
  fail "esbuild not installed; run 'npm install'"
  exit 1
fi

node "$ESBUILD_BIN" bin/registry-tests/entry.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --log-level=warning \
  --outfile="$BUNDLE"
node "$ESBUILD_BIN" bin/registry-tests/e2e.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --log-level=warning \
  --outfile="$E2E_BUNDLE"
ok "test bundle generated"

info "3/3 running registry / slugify / validation checks"
node "$BUNDLE"
node "$E2E_BUNDLE"

# Sanity: the acceptance scenarios called out in the task brief are
# covered by the bundled checks above.
info "scenario: file name with spaces maps to a hyphenated key"
info "scenario: case-only duplicate id is rejected and list length stays the same"
info "scenario: same-key concurrent commit loses CAS, batch rolls back, draft retained"

ok "all registry acceptance checks passed"
