# Cloud environment

## Environment variables

```
KRU_STORE_REPO=ap-justin/kru-store
```

## Network access

Custom, *include defaults* on, plus:

```
get.pnpm.io
nodejs.org
ppa.launchpadcontent.net
mcp.context7.com
www.irs.gov
apps.irs.gov
api.turso.tech
*.turso.io
mcp.turso.ai
vercel.com
api.vercel.com
```

## Setup script

```bash
#!/bin/bash
# kru v0.141.0
set -uo pipefail
exec > >(tee -a /tmp/setup.log) 2>&1

try() {
  for _ in 1 2 3; do "$@" && return 0; sleep 2; done
  echo "SETUP FAIL: $*"
}

# kru store
try git clone -q https://github.com/ap-justin/kru-store ~/.kru
[ -f ~/.kru/setup.sh ] && try bash ~/.kru/setup.sh

# plugins
try claude plugin marketplace add anthropics/claude-plugins-official
try claude plugin marketplace add ap-justin/kru
try claude plugin install kru@kru --scope user
try claude plugin enable cc-plugin-you-should-know@builtin --scope user
try claude plugin marketplace add tursodatabase/turso-mcp
try claude plugin install turso@turso --scope user

# nonprofits: node 24 (`.nvmrc`, `engines`) and pnpm 12.4.2 (`packageManager`)
node_24() {
  f=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o 'node-v24[^ ]*-linux-x64.tar.xz') &&
    curl -fsSL "https://nodejs.org/dist/latest-v24.x/$f" | tar -xJ -C /usr/local --strip-components=1
}
try node_24
try env SHELL=/bin/bash PNPM_VERSION=12.4.2 bash -c 'curl -fsSL https://get.pnpm.io/install.sh | sh -'

node --version; pnpm --version; claude plugin list
exit 0
```
