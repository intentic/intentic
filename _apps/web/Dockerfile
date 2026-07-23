# The intentic platform web SPA image (registry.gitlab.com/radarsu/intentic/web): the Vue 3 SPA as static
# files behind nginx. One build artifact serves any environment — the API origin is a `$API_URL` placeholder
# in assets/js/env.js (environment.deployment.ts), substituted by the CMD at container start, so the same
# image points at any api.
#
# Deliberately a pure COPY wrapper: ./dist is built OUTSIDE Docker by the `docker:release` turbo task
# (dependsOn build — vue-tsc + vite + the deployment env bundle, warm cache; see
# _tools/scripts/docker-release.sh). The context is this app dir; .dockerignore keeps only dist + nginx.conf:
#   pnpm --filter=@intentic-app/web build && docker build -t …/web _apps/web
FROM nginx:1.27-alpine
LABEL org.opencontainers.image.source=https://gitlab.com/radarsu/intentic
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist /usr/share/nginx/html
EXPOSE 80
# Substitute the runtime env into the served env.js, then hand off to nginx. Restricting envsubst to exactly
# these two names leaves every other `$…` in the minified bundle untouched; an unset POSTHOG_KEY becomes ""
# (analytics off) while API_URL is required — the SPA is unreachable-api dead weight without it. Staged
# through /tmp and written back with cat so the target keeps the COPY layer's 0644 (a fresh redirect target
# would too, but never perms that 403 under the unprivileged nginx worker).
CMD : "${API_URL:?API_URL is required (e.g. https://api.intentic.dev)}" \
    && envsubst '$API_URL $POSTHOG_KEY' < /usr/share/nginx/html/assets/js/env.js > /tmp/env.js \
    && cat /tmp/env.js > /usr/share/nginx/html/assets/js/env.js \
    && exec nginx -g 'daemon off;'
