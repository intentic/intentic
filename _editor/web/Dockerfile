# The intentic platform web SPA image (ghcr.io/intentic/web): the Vue 3 SPA as static
# files behind nginx. One build artifact serves any environment — the API origin is a `$API_URL` placeholder
# in assets/js/env.js (environment.deployment.ts) and the PostHog proxy upstreams are placeholders in
# nginx.conf, all substituted by entrypoint.sh at container start, so the same image points anywhere.
#
# Deliberately a pure COPY wrapper: ./dist is built OUTSIDE Docker by the `docker:release` turbo task
# (dependsOn build — vue-tsc + vite + the deployment env bundle, warm cache; see
# _tools/scripts/platform/docker-release.sh). The context is this app dir; .dockerignore keeps only dist, nginx.conf
# and entrypoint.sh:
#   pnpm --filter=@intentic/web build && docker build -t …/web _editor/web
FROM nginx:1.30.4-alpine3.24@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic
# Staged as a template, not dropped straight into conf.d — the entrypoint renders it. Also NOT into the base
# image's /etc/nginx/templates/, whose auto-envsubst runs with no variable filter and would blank every $uri.
COPY nginx.conf /etc/nginx/default.conf.template
# --chmod because CMD execs this directly: the source file's mode is whatever the checkout gave it, and the
# monorepo restructure landed it 0644 — which the image only reveals at container start, as a crash loop.
COPY --chmod=0755 entrypoint.sh /entrypoint.sh
COPY dist /usr/share/nginx/html
# THE SAME LESSON AS THE LINE ABOVE, one directory wider: a COPY carries the build tree's modes into the image,
# and the tree these jobs build in OUTLIVES them (the CI workspace is persistent and `dist` is on the kept
# list). One file in it, `assets/js/env.js`, is written by esbuild over whatever is already there — esbuild
# truncates rather than recreates, so a mode is inherited forever once it lands. A 0600 there costs the whole
# app: nginx's worker is unprivileged, the request for env.js answers 403, `window.env` is never defined, and
# what a visitor gets is a login page that cannot sign anybody in. The onboarding tier caught it that way, as
# three specs about the SPA while every asset beside it served 200.
# `a+rX` and not a blanket 0644: the capital X adds execute for directories only, which is what makes the tree
# traversable without marking every static asset executable.
RUN chmod -R a+rX /usr/share/nginx/html
EXPOSE 80
# Naming the script (rather than nginx) as the command also makes the base entrypoint skip its
# /docker-entrypoint.d/ init scripts — it only runs those when the command is nginx itself.
CMD ["/entrypoint.sh"]
