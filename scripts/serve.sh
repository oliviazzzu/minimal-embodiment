#!/bin/bash
# Start the bridge service.
#
# Required environment variable:
#   US_BRIDGE_TOKEN  — bearer token clients must present. Generate one with:
#                      openssl rand -hex 24
# Optional:
#   PORT             — port to listen on (default 3737)

set -euo pipefail

if [[ -z "${US_BRIDGE_TOKEN:-}" ]]; then
  echo "error: US_BRIDGE_TOKEN is not set."
  echo "       Generate one with:  export US_BRIDGE_TOKEN=\"\$(openssl rand -hex 24)\""
  exit 1
fi

cd "$(dirname "$0")/.."

if [[ ! -f dist/http-bridge.js ]]; then
  echo "dist/http-bridge.js not found — running build first."
  npm run build
fi

exec node dist/http-bridge.js
