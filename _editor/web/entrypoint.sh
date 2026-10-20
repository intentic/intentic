#!/bin/sh
# Container start for the web image: render the two templates that carry deploy-time values, then hand off to
# nginx. One build artifact serves any environment — nothing here is baked at image build time.
#
# Both envsubst calls name their variables explicitly. That restriction is the whole point: the minified SPA
# bundle and nginx.conf are both full of `$…` that must survive untouched ($uri, $proxy_add_x_forwarded_for,
# and whatever the minifier emitted), and an unrestricted envsubst would blank every one of them.
set -eu

: "${API_URL:?API_URL is required (e.g. https://api.intentic.dev)}"

# PostHog upstreams for the /wire reverse proxy (nginx.conf). Defaulted rather than required: an unset
# POSTHOG_KEY already leaves analytics off in the SPA, and these only matter for a project in another region.
export POSTHOG_UI_HOST="${POSTHOG_UI_HOST:-https://us.posthog.com}"
export POSTHOG_API_HOST="${POSTHOG_API_HOST:-us.i.posthog.com}"
export POSTHOG_ASSETS_HOST="${POSTHOG_ASSETS_HOST:-us-assets.i.posthog.com}"

# nginx needs an explicit resolver to resolve proxy_pass hostnames at request time, and has no way to read
# resolv.conf itself — so lift the container's own nameservers out of it (127.0.0.11 under a compose network,
# the cluster DNS under k8s). v6 addresses have to be bracketed for the resolver directive. The final fallback
# covers a resolv.conf with no usable nameserver line: a bad address only 502s /wire, whereas an empty
# `resolver;` is a config error that would stop nginx from starting at all.
export NGINX_RESOLVER="${NGINX_RESOLVER:-$(awk '/^nameserver/ { print $2 }' /etc/resolv.conf | head -3 | sed 's/^.*:.*$/[&]/' | tr '\n' ' ')}"
export NGINX_RESOLVER="${NGINX_RESOLVER:-127.0.0.11}"

# Defaulted rather than required: nginx omits an add_header whose value is empty, so an unset WEB_BUILD would
# drop the header the deploy waits on instead of answering something a deploy can refuse.
export WEB_BUILD="${WEB_BUILD:-unreleased}"

envsubst '$NGINX_RESOLVER $POSTHOG_API_HOST $POSTHOG_ASSETS_HOST $WEB_BUILD' \
    < /etc/nginx/default.conf.template > /etc/nginx/conf.d/default.conf

# Staged through /tmp and written back with cat so the target keeps the COPY layer's 0644 (a fresh redirect
# target would too, but never perms that 403 under the unprivileged nginx worker). An unset POSTHOG_KEY
# becomes "" here, which is what switches the SPA's analytics off.
envsubst '$API_URL $POSTHOG_KEY $POSTHOG_UI_HOST' < /usr/share/nginx/html/assets/js/env.js > /tmp/env.js
cat /tmp/env.js > /usr/share/nginx/html/assets/js/env.js

# The same config inlined into index.html, in place of the tag that loads it: that tag is a render-blocking script
# served no-store, a full round trip to this origin before the page could parse another line, which a phone on a
# cellular link pays on every start. env.js stays served for anything that still asks for it. Read through ENVIRON, not
# `awk -v`, which would interpret backslashes in the minified script.
ENV_JS="$(cat /tmp/env.js)" awk '
    index($0, "<script src=\"/assets/js/env.js\"></script>") { print "        <script>" ENVIRON["ENV_JS"] "</script>"; next }
    { print }
' /usr/share/nginx/html/index.html > /tmp/index.html
cat /tmp/index.html > /usr/share/nginx/html/index.html

# Digital Asset Links for the native Android editor app (dev.intentic.app), at /.well-known/assetlinks.json: App Links
# (handle_all_urls) and the editor's passkeys (get_login_creds), which Android's Credential Manager checks before it lets
# the app use them. Every sandbox reads this same file to admit the app's passkey sign-in
# (_sandbox/sandbox/src/auth/passkeys/app-origins.ts), so this variable is the one place the app's signing certificates
# are named. ANDROID_APP_FINGERPRINTS: comma-separated SHA-256 certificate fingerprints as keytool and the Play console
# print them (32 colon-separated hex pairs): the Play app-signing key, then any upload or debug key to admit. Unset, no
# file is written, nginx answers 404 and no app is admitted. A malformed entry is skipped and said, never left to stop
# the editor starting.
WELL_KNOWN=/usr/share/nginx/html/.well-known
fingerprints=""
for fingerprint in $(printf '%s' "${ANDROID_APP_FINGERPRINTS:-}" | tr ',' ' '); do
    if printf '%s' "$fingerprint" | grep -Eq '^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}$'; then
        fingerprints="${fingerprints:+$fingerprints, }\"$(printf '%s' "$fingerprint" | tr 'a-f' 'A-F')\""
    else
        echo "entrypoint: skipping ANDROID_APP_FINGERPRINTS entry '$fingerprint': not a SHA-256 fingerprint (32 colon-separated hex pairs)" >&2
    fi
done
if [ -n "$fingerprints" ]; then
    mkdir -p "$WELL_KNOWN"
    cat > "$WELL_KNOWN/assetlinks.json" <<JSON
[
    {
        "relation": ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
        "target": { "namespace": "android_app", "package_name": "dev.intentic.app", "sha256_cert_fingerprints": [$fingerprints] }
    }
]
JSON
    chmod a+rX "$WELL_KNOWN" "$WELL_KNOWN/assetlinks.json"
fi

exec nginx -g 'daemon off;'
