#!/bin/sh
# Substitute the runtime env placeholders baked into env.js by environment.deployment.ts. Runs before nginx
# (the base image execs /docker-entrypoint.d/*.sh first). Restricting envsubst to exactly these two names
# leaves every other `$…` in the minified bundle untouched. An unset POSTHOG_KEY becomes "" → analytics stay
# off; API_URL is required (the SPA can't reach the api without it).
set -e
me=$(basename "$0")
: "${API_URL:?[$me] API_URL is required (e.g. https://api.intentic.dev)}"
: "${POSTHOG_KEY:=}"
export API_URL POSTHOG_KEY

target=/usr/share/nginx/html/assets/js/env.js
echo "[$me] injecting runtime env (API_URL=$API_URL) into $target"
tmp=$(mktemp)
envsubst '$API_URL $POSTHOG_KEY' < "$target" > "$tmp"
mv "$tmp" "$target"
# mktemp creates 0600; the nginx worker drops root, so an unreadable env.js would 403 and strand the SPA.
chmod 0644 "$target"
