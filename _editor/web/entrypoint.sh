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
export POSTHOG_API_HOST="${POSTHOG_API_HOST:-us.i.posthog.com}"
export POSTHOG_ASSETS_HOST="${POSTHOG_ASSETS_HOST:-us-assets.i.posthog.com}"

# nginx needs an explicit resolver to resolve proxy_pass hostnames at request time, and has no way to read
# resolv.conf itself — so lift the container's own nameservers out of it (127.0.0.11 under a compose network,
# the cluster DNS under k8s). v6 addresses have to be bracketed for the resolver directive. The final fallback
# covers a resolv.conf with no usable nameserver line: a bad address only 502s /wire, whereas an empty
# `resolver;` is a config error that would stop nginx from starting at all.
export NGINX_RESOLVER="${NGINX_RESOLVER:-$(awk '/^nameserver/ { print $2 }' /etc/resolv.conf | head -3 | sed 's/^.*:.*$/[&]/' | tr '\n' ' ')}"
export NGINX_RESOLVER="${NGINX_RESOLVER:-127.0.0.11}"

envsubst '$NGINX_RESOLVER $POSTHOG_API_HOST $POSTHOG_ASSETS_HOST' \
    < /etc/nginx/default.conf.template > /etc/nginx/conf.d/default.conf

# Staged through /tmp and written back with cat so the target keeps the COPY layer's 0644 (a fresh redirect
# target would too, but never perms that 403 under the unprivileged nginx worker). An unset POSTHOG_KEY
# becomes "" here, which is what switches the SPA's analytics off.
envsubst '$API_URL $POSTHOG_KEY' < /usr/share/nginx/html/assets/js/env.js > /tmp/env.js
cat /tmp/env.js > /usr/share/nginx/html/assets/js/env.js

exec nginx -g 'daemon off;'
