#!/usr/bin/env bash
#
# Acceptance checks for the Artifact registry:
#   1. production build (npm run build)
#   2. registry unit tests (slugify, static validation, CAS store)
#
# The test entry is TypeScript, so it is bundled on the fly with the
# project's own esbuild — no extra dev dependency, works in Git Bash/WSL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${YELLOW}$*${NC}"; }
ok() { echo -e "${GREEN}$*${NC}"; }
fail() { echo -e "${RED}$*${NC}"; }

info "==> [1/2] npm run build"
npm run build

info "==> [2/2] registry unit tests"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
BUNDLE="$TMP_DIR/test-registry.cjs"

node node_modules/esbuild/bin/esbuild \
  scripts/test-registry.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node20 \
  --outfile="$BUNDLE" \
  --log-level=warning

node "$BUNDLE"

ok "==> registry acceptance passed"
