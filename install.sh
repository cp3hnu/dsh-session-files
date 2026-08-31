#!/usr/bin/env bash
# Official installer for @deepseek-ai/dsh-session-files.
#
# Uses the documented `dsh plugin add` flow (`dsh plugin` is a thin pnpm
# forwarder). The package declares `dsh.bundle.patch` (its own
# cordis.patch.yml), so `plugin add` alone fully activates it: no manual
# profile patch editing is needed.
#
# Usage:
#   bash install.sh [path/to/package.tgz]        # PROFILE env overrides profile
#
# Environment:
#   PROFILE  (default: web)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${PROFILE:-web}"
NAME="@deepseek-ai/dsh-session-files"

# ── 0) prerequisites ─────────────────────────────────────────────────────────
if ! command -v dsh >/dev/null 2>&1; then
  echo "error: dsh 未安装(需要 dsh CLI 执行官方安装命令)" >&2
  exit 1
fi

# ── 1) resolve the tarball ───────────────────────────────────────────────────
TGZ="${1:-}"
if [ -z "$TGZ" ]; then
  TGZ="$(ls -t "$SCRIPT_DIR"/deepseek-ai-dsh-session-files-*.tgz 2>/dev/null | head -1 || true)"
fi
if [ -z "$TGZ" ] || [ ! -f "$TGZ" ]; then
  echo "[pack] 未找到 tarball,先执行 npm pack …"
  (cd "$SCRIPT_DIR" && npm pack --silent)
  TGZ="$(ls -t "$SCRIPT_DIR"/deepseek-ai-dsh-session-files-*.tgz | head -1)"
fi
TGZ="$(realpath "$TGZ")"
echo "tarball : $TGZ"

# ── 2) official install: dsh plugin add ──────────────────────────────────────
echo "profile : $PROFILE"
echo "running: dsh --profile $PROFILE plugin add $TGZ"
dsh --profile "$PROFILE" plugin add "$TGZ"

# ── 3) restart hint (generic; the host runs however you run it) ─────────────
echo
echo "installed. restart dsh so the profile re-composes, then refresh the browser."