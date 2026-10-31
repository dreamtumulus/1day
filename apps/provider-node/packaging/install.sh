#!/usr/bin/env bash
# 1DayAPI Provider Node installer.
#
# Release mode (one-liner):
#   curl -fsSL https://releases.1dayapi.com/provider-node/install.sh | bash
#
# Platform bundle mode (single-file JS built with `bun build`):
#   bash install.sh --bundle-url "https://api.1dayapi.com/internal/provider/bundle?code=bind_..."
#
# Development mode (from a local checkout of the monorepo):
#   bash packaging/install.sh --local /path/to/1dayAPI.com
#
# Environment:
#   1DAYAPI_NODE_DIST        Release base URL (default https://releases.1dayapi.com/provider-node)
#   1DAYAPI_NODE_VERSION     Release version to install (default 0.1.0)
#   1DAYAPI_NODE_BUNDLE_URL  Platform bundle URL (same as --bundle-url)
#   PREFIX                   Install prefix (default system-wide; e.g. PREFIX=/tmp/testroot
#                            installs into /tmp/testroot/opt and /tmp/testroot/usr/local/bin)
#
# Protocol v2 requires the Bun runtime (pinned 1.4.4, matching the runtime
# embedded in Claude Code 2.1.312). The installer installs Bun when missing
# and reuses an existing 1.4.4 install.
set -euo pipefail

BUN_VERSION="1.4.4"

# Note: 1DAYAPI_* names start with a digit, which is not a valid shell
# identifier — read them via printenv instead of parameter expansion.
VERSION="$(printenv 1DAYAPI_NODE_VERSION 2>/dev/null || true)"
VERSION="${VERSION:-0.1.0}"
BASE_URL="$(printenv 1DAYAPI_NODE_DIST 2>/dev/null || true)"
BASE_URL="${BASE_URL:-https://releases.1dayapi.com/provider-node}"
BASE_URL="${BASE_URL%/}"
BUNDLE_URL="$(printenv 1DAYAPI_NODE_BUNDLE_URL 2>/dev/null || true)"
PREFIX="${PREFIX:-}"
APP_DIR="${PREFIX}/opt/1dayapi-provider-node"
BIN_DIR="${PREFIX}/usr/local/bin"
BIN_PATH="${BIN_DIR}/1dayapi-node"
LOCAL_REPO=""
TMPDIR_WORK=""

log() { printf '1dayapi-node installer: %s\n' "$*"; }
fail() { printf '1dayapi-node installer: %s\n' "$*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }

cleanup() {
  if [ -n "${TMPDIR_WORK}" ]; then rm -rf "${TMPDIR_WORK}"; fi
  return 0
}
trap cleanup EXIT

# sudo only when we actually touch system paths.
as_root() {
  if [ -z "${PREFIX}" ] && [ "$(id -u)" -ne 0 ]; then
    sudo "$@"
  else
    "$@"
  fi
}

bun_ok() {
  [ -x "$1" ] || return 1
  [ "$("$1" --version 2>/dev/null || true)" = "${BUN_VERSION}" ]
}

find_bun() {
  local candidate
  for candidate in "${HOME}/.bun/bin/bun" "$(command -v bun 2>/dev/null || true)" /usr/local/bin/bun; do
    if [ -n "${candidate}" ] && bun_ok "${candidate}"; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

# Bun is installed for the invoking user (never via sudo): the systemd user
# service runs as this user and reads ~/.bun/bin/bun through the bun-path hint.
install_bun() {
  local existing
  if existing="$(find_bun)"; then
    log "using Bun ${BUN_VERSION} at ${existing}"
    return 0
  fi
  need_cmd curl
  need_cmd unzip
  log "installing Bun ${BUN_VERSION}"
  curl -fsSL --connect-timeout 10 --max-time 300 https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    || fail "Bun installation failed; install Bun ${BUN_VERSION} from https://bun.sh and rerun"
  hash -r 2>/dev/null || true
  find_bun >/dev/null || fail "Bun installation did not complete. Install Bun ${BUN_VERSION} from https://bun.sh and rerun."
  log "installed Bun $( "${HOME}/.bun/bin/bun" --version )"
}

# Persist the Bun interpreter validated during this install so the wrapper
# (and the systemd unit it spawns) reuse it regardless of PATH.
write_bun_hint() {
  local bun_bin
  bun_bin="$(find_bun 2>/dev/null || true)"
  [ -n "${bun_bin}" ] || return 0
  printf '%s\n' "${bun_bin}" > "${TMPDIR_WORK:-/tmp}/.1dayapi-bun-path.$$"
  as_root cp "${TMPDIR_WORK:-/tmp}/.1dayapi-bun-path.$$" "${APP_DIR}/bun-path"
  rm -f "${TMPDIR_WORK:-/tmp}/.1dayapi-bun-path.$$"
  as_root chmod 600 "${APP_DIR}/bun-path"
  log "recorded Bun interpreter: ${bun_bin}"
}

# cc_worker mode (docs/ccr-supply.md §8.1) executes requests with the real
# Claude Code binary, pinned to the fingerprint-anchored version. Best-effort:
# a node without claude still serves official_exit/http_egress and simply
# reports ccWorker.enabled=false in its heartbeat.
CLAUDE_VERSION="2.1.312"
install_claude() {
  if command -v claude >/dev/null 2>&1 && claude --version 2>/dev/null | grep -q "${CLAUDE_VERSION}"; then
    log "claude $(claude --version 2>/dev/null | head -1) already installed"
    return 0
  fi
  if command -v npm >/dev/null 2>&1; then
    as_root npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" && { log "installed claude ${CLAUDE_VERSION} (npm)"; return 0; }
  fi
  local bun_bin
  bun_bin="$(find_bun 2>/dev/null || true)"
  if [ -n "${bun_bin}" ]; then
    "${bun_bin}" add -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" && { log "installed claude ${CLAUDE_VERSION} (bun, ~/.bun/bin)"; return 0; }
  fi
  log "WARNING: could not install claude ${CLAUDE_VERSION} (no npm/bun route); cc_worker mode disabled on this node"
}

# Worker isolation (docs/ccr-supply.md §8.1): the node runs Claude Code workers as
# an unprivileged service account inside a per-session scratch dir, so the binary
# must live somewhere that account can execute (not under /root/.bun).
setup_worker_user() {
  if ! id ccworker >/dev/null 2>&1; then
    as_root useradd --system --no-create-home --shell /usr/sbin/nologin ccworker && log "created service user ccworker"
  fi
  # Worker root must be traversable by ccworker; the node's data dir under /root is not (0700).
  as_root mkdir -p /var/lib/1dayapi-cc-worker && as_root chmod 711 /var/lib/1dayapi-cc-worker
  local real; real="$(readlink -f "$(command -v claude 2>/dev/null || true)" 2>/dev/null || true)"
  if [ -n "${real}" ] && ! sudo -u ccworker test -x "${real}" 2>/dev/null; then
    as_root mkdir -p /opt/claude && as_root cp -f "${real}" /opt/claude/claude && as_root chmod 755 /opt/claude/claude \
      && as_root ln -sfn /opt/claude/claude /usr/local/bin/claude && log "exposed claude at /opt/claude/claude for ccworker"
  fi
  if [ "$(id -u)" -eq 0 ] && { ! command -v cc >/dev/null 2>&1 || ! command -v unshare >/dev/null 2>&1 || ! command -v setpriv >/dev/null 2>&1; }; then
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gcc libc6-dev util-linux
  fi
  verify_worker_isolation
  return 0
}

# Same check the node runs at startup (CcWorkerManager.selfTest): can ccworker
# execute claude from a private scratch dir under the worker root? A failure
# here is exactly the "EACCES mkdir" incident of 2026-10-16 — fix before
# starting the node instead of discovering it as 502s on customer traffic.
verify_worker_isolation() {
  local d=/var/lib/1dayapi-cc-worker/cc-sessions/install-selftest out
  as_root mkdir -p "${d}" && as_root chmod 700 "${d}" && as_root chown ccworker:ccworker "${d}" || { log "WARNING: cannot prepare ${d}"; return 0; }
  if out="$(as_root su -s /bin/sh ccworker -c "cd ${d} && HOME=${d} TMPDIR=${d} CLAUDE_CONFIG_DIR=${d} claude --version" 2>&1)"; then
    log "worker isolation self-test PASSED: ccworker ran claude ${out} in ${d}"
  else
    log "ERROR: worker isolation self-test FAILED — the node will reject cc_worker sessions until fixed:"
    log "  ${out}"
    log "  check: id ccworker; ls -ld /var/lib/1dayapi-cc-worker; sudo -u ccworker claude --version"
  fi
  as_root rm -rf "${d}"
}

# Deploy a built provider-node from the monorepo into APP_DIR as a
# self-contained install (pnpm deploy materializes prod dependencies).
install_from_local() {
  local repo="$1"
  local app="${repo}/apps/provider-node"
  [ -d "${app}" ] || fail "--local expects the monorepo root; ${app} not found"
  [ -f "${app}/dist/cli.js" ] || fail "${app}/dist is missing; run: pnpm --filter @1dayapi/provider-node build"
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is required for --local installs"

  log "deploying self-contained build from ${repo}"
  TMPDIR_WORK="${TMPDIR_WORK:-$(mktemp -d)}"
  (cd "${repo}" && pnpm --filter @1dayapi/provider-node deploy --prod "${TMPDIR_WORK}/deploy")
  as_root mkdir -p "${PREFIX}/opt" "${BIN_DIR}"
  as_root rm -rf "${APP_DIR}"
  as_root cp -r "${TMPDIR_WORK}/deploy" "${APP_DIR}"
  # A stale bundle from a previous bundle-mode install would shadow dist.
  as_root rm -f "${APP_DIR}/bundle.js"
}

# Download a single-file JS bundle (built by the platform with `bun build`)
# into APP_DIR/bundle.js; the wrapper prefers it over dist/cli.js.
install_from_bundle() {
  local url="$1"
  need_cmd curl
  TMPDIR_WORK="$(mktemp -d)"
  log "downloading bundle ${url}"
  curl -fL --retry 3 --connect-timeout 10 --max-time 300 "${url}" -o "${TMPDIR_WORK}/bundle.js" \
    || fail "bundle download failed: ${url}"
  [ -s "${TMPDIR_WORK}/bundle.js" ] || fail "bundle is empty: ${url}"

  as_root mkdir -p "${PREFIX}/opt" "${BIN_DIR}"
  as_root rm -rf "${APP_DIR}"
  as_root mkdir -p "${APP_DIR}"
  as_root cp "${TMPDIR_WORK}/bundle.js" "${APP_DIR}/bundle.js"
  as_root chmod 644 "${APP_DIR}/bundle.js"
  log "installed bundle ${APP_DIR}/bundle.js"
}

# Download a release tarball produced by CI:
#   ${BASE_URL}/v${VERSION}/1dayapi-provider-node-linux-${arch}.tar.gz
# layout: opt/1dayapi-provider-node/... + usr/local/bin/1dayapi-node
install_from_release() {
  local arch="$1"
  need_cmd curl
  need_cmd tar
  TMPDIR_WORK="$(mktemp -d)"
  local name="1dayapi-provider-node-linux-${arch}.tar.gz"
  local url="${BASE_URL}/v${VERSION}/${name}"
  log "downloading ${url}"
  curl -fL --retry 3 --connect-timeout 10 --max-time 300 "${url}" -o "${TMPDIR_WORK}/${name}" \
    || fail "release artifact not found: ${url}"

  if curl -fsSL --connect-timeout 10 --max-time 60 "${BASE_URL}/v${VERSION}/checksums.txt" -o "${TMPDIR_WORK}/checksums.txt" 2>/dev/null; then
    local expected actual
    expected="$(awk -v n="${name}" '$2 == n { print $1 }' "${TMPDIR_WORK}/checksums.txt" | head -n 1)"
    [ -n "${expected}" ] || fail "checksums.txt does not list ${name}"
    actual="$(sha256sum "${TMPDIR_WORK}/${name}" | awk '{print $1}')"
    [ "${actual}" = "${expected}" ] || fail "checksum mismatch for ${name}"
    log "verified sha256 for ${name}"
  else
    log "warning: no checksums.txt at ${BASE_URL}/v${VERSION}/; skipping integrity verification"
  fi

  if [ -z "${PREFIX}" ]; then
    as_root tar -C / -xzf "${TMPDIR_WORK}/${name}"
  else
    # PREFIX installs: strip the leading / from tarball paths.
    as_root mkdir -p "${PREFIX}"
    tar -C "${PREFIX}" --warning=no-unknown-keyword -xzf "${TMPDIR_WORK}/${name}"
  fi

  # The tarball ships the wrapper with __APP_DIR__/__BIN_PATH__ placeholders;
  # substitute them for this installation.
  if grep -q '__APP_DIR__' "${BIN_PATH}" 2>/dev/null; then
    sed -e "s|__APP_DIR__|${APP_DIR}|g" -e "s|__BIN_PATH__|${BIN_PATH}|g" "${BIN_PATH}" > "${TMPDIR_WORK}/wrapper"
    as_root cp "${TMPDIR_WORK}/wrapper" "${BIN_PATH}"
    as_root chmod 755 "${BIN_PATH}"
  fi
  log "installed CLI wrapper ${BIN_PATH}"
}

write_wrapper() {
  local template
  template="$(cd "$(dirname "$0")" && pwd)/linux/1dayapi-node"
  if [ ! -f "${template}" ]; then
    # curl|bash mode: fetch the wrapper template from the release base URL.
    TMPDIR_WORK="${TMPDIR_WORK:-$(mktemp -d)}"
    template="${TMPDIR_WORK}/1dayapi-node"
    curl -fsSL --connect-timeout 10 --max-time 60 "${BASE_URL}/v${VERSION}/1dayapi-node" -o "${template}" \
      || fail "wrapper template not found locally and not downloadable from ${BASE_URL}"
  fi
  as_root mkdir -p "${BIN_DIR}"
  sed -e "s|__APP_DIR__|${APP_DIR}|g" -e "s|__BIN_PATH__|${BIN_PATH}|g" "${template}" > "${TMPDIR_WORK:-/tmp}/.1dayapi-node.wrapper.$$"
  as_root cp "${TMPDIR_WORK:-/tmp}/.1dayapi-node.wrapper.$$" "${BIN_PATH}"
  rm -f "${TMPDIR_WORK:-/tmp}/.1dayapi-node.wrapper.$$"
  as_root chmod 755 "${BIN_PATH}"
  log "installed CLI wrapper ${BIN_PATH}"
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --local) LOCAL_REPO="${2:-}"; shift 2 ;;
      --bundle-url) BUNDLE_URL="${2:-}"; shift 2 ;;
      *) fail "unknown argument: $1 (usage: install.sh [--local /path/to/monorepo | --bundle-url URL])" ;;
    esac
  done

  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}" in
    Linux) ;;
    Darwin) fail "macOS is not supported by this installer yet. For now: pnpm --filter @1dayapi/provider-node build && bun apps/provider-node/dist/cli.js serve" ;;
    *) fail "${os} is not supported by this installer" ;;
  esac
  case "${arch}" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail "Linux ${arch} is not supported yet" ;;
  esac

  install_bun

  if [ -n "${LOCAL_REPO}" ]; then
    install_from_local "${LOCAL_REPO}"
    write_wrapper
  elif [ -n "${BUNDLE_URL}" ]; then
    install_from_bundle "${BUNDLE_URL}"
    write_wrapper
  else
    install_from_release "${arch}"
  fi
  write_bun_hint
  install_claude
  setup_worker_user

  log "done. Next steps:"
  log "  ${BIN_PATH} install-service   # install + enable the systemd user unit"
  log "  ${BIN_PATH} restart           # start the node and wait for the console"
  log "  ${BIN_PATH} status            # check bridge state"
  log "local console: http://127.0.0.1:16889"
}

main "$@"
