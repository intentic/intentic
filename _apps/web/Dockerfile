# The intentic platform web SPA image (registry.gitlab.com/radarsu/intentic/web): the Vue 3 SPA as static
# files behind nginx. One build artifact serves any environment — the API origin is a `$API_URL` placeholder
# in assets/js/env.js (environment.deployment.ts), substituted by the docker-entrypoint.d script at container
# start, so the same image points at any api.
#
# Deliberately a pure COPY wrapper: ./dist is built OUTSIDE Docker by the `docker:release` turbo task
# (dependsOn build — vue-tsc + vite + the deployment env bundle, warm cache; see
# _tools/scripts/docker-release.sh). The context is THIS app dir (Dockerfile.dockerignore keeps only dist,
# nginx.conf, and docker-entrypoint.d):
#   pnpm --filter=@intentic-app/web build && docker build -t …/web _apps/web
FROM nginx:1.27-alpine
LABEL org.opencontainers.image.source=https://gitlab.com/radarsu/intentic
COPY nginx.conf /etc/nginx/conf.d/default.conf
# The base image execs every /docker-entrypoint.d/*.sh before nginx — this one rewrites the runtime env
# placeholders ($API_URL/$POSTHOG_KEY) into the served env.js.
COPY --chmod=755 docker-entrypoint.d/40-intentic-env.sh /docker-entrypoint.d/40-intentic-env.sh
COPY dist /usr/share/nginx/html
EXPOSE 80
