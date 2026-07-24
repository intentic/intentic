# The intentic platform web SPA image (registry.gitlab.com/radarsu/intentic/web): the Vue 3 SPA as static
# files behind nginx. One build artifact serves any environment — the API origin is a `$API_URL` placeholder
# in assets/js/env.js (environment.deployment.ts) and the PostHog proxy upstreams are placeholders in
# nginx.conf, all substituted by entrypoint.sh at container start, so the same image points anywhere.
#
# Deliberately a pure COPY wrapper: ./dist is built OUTSIDE Docker by the `docker:release` turbo task
# (dependsOn build — vue-tsc + vite + the deployment env bundle, warm cache; see
# _tools/scripts/docker-release.sh). The context is this app dir; .dockerignore keeps only dist, nginx.conf
# and entrypoint.sh:
#   pnpm --filter=@intentic-app/web build && docker build -t …/web _apps/web
FROM nginx:1.27-alpine
LABEL org.opencontainers.image.source=https://gitlab.com/radarsu/intentic
# Staged as a template, not dropped straight into conf.d — the entrypoint renders it. Also NOT into the base
# image's /etc/nginx/templates/, whose auto-envsubst runs with no variable filter and would blank every $uri.
COPY nginx.conf /etc/nginx/default.conf.template
COPY entrypoint.sh /entrypoint.sh
COPY dist /usr/share/nginx/html
EXPOSE 80
# Naming the script (rather than nginx) as the command also makes the base entrypoint skip its
# /docker-entrypoint.d/ init scripts — it only runs those when the command is nginx itself.
CMD ["/entrypoint.sh"]
