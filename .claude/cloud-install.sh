#!/bin/bash
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

# the pnpm the setup script installed, pinned by `packageManager`
ver=$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\).*/\1/p' package.json)
[ -n "$ver" ] || { echo "cloud-install: no pnpm pin in packageManager" >&2; exit 1; }
exe="${PNPM_HOME:-$HOME/.local/share/pnpm}/.tools/pnpm-exe/$ver/pnpm"

# link the binary, not the `pnpm` wrapper in PNPM_HOME: the wrapper resolves the
# binary beside its own path, so a link to it breaks.
bin="$HOME/.kru-bin"
mkdir -p "$bin"
ln -sf "$exe" "$bin/pnpm"
# the setup script installs the repo's node (`.nvmrc`) into /usr/local, but the
# image's /opt/node22/bin comes first on PATH and would run every command on 22.
node_bin=/usr/local/bin/node
if [ -x "$node_bin" ] && "$node_bin" --version | grep -q "^v$(cat .nvmrc)\."; then
  ln -sf "$node_bin" "$bin/node"
fi
export PATH="$bin:$PATH"
# later shells source CLAUDE_ENV_FILE. without this line they find the image's
# pnpm, which self-switches to `packageManager` with lifecycle scripts off, and
# turbo, which spawns that placeholder directly, fails with `Exec format error`.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

pnpm install --frozen-lockfile
