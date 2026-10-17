# The intentic platform web SPA image (ghcr.io/intentic/web): the Vue 3 SPA as static
# files behind nginx. One build artifact serves any environment — the API origin is a `$API_URL` placeholder
# in assets/js/env.js (environment.deployment.ts) and the PostHog proxy upstreams are placeholders in
# nginx.conf, all substituted by entrypoint.sh at container start, so the same image points anywhere.
#
# ./dist is built OUTSIDE Docker by the `docker:release` turbo task (dependsOn build — vue-tsc + vite + the deployment
# env bundle, warm cache; see _tools/scripts/platform/docker-release.sh). The context is this app dir; .dockerignore
# keeps only dist, nginx.conf and entrypoint.sh:
#   pnpm --filter=@intentic/web build && docker build -t …/web _editor/web

# The one build step here, for two things the served image needs and the nginx image lacks:
# 1. ngx_brotli's static module, so nginx answers with the .br it finds beside a file. nginx.org packages no brotli
#    module, so it is compiled against this exact nginx (--with-compat). Only the static half: it reads files and needs
#    no brotli library. Both sources are pinned by checksum; bumping the base image's nginx means a new nginx sum.
# 2. The bundle precompressed once at the highest levels (brotli 11, gzip 9). On the editor's own main chunk that is
#    19.6% of the file against 22-24% from an edge encoding on the fly (Cloudflare), and a deploy with no such edge in
#    front otherwise sends 23 MB uncompressed. index.html and env.js are rewritten at start (entrypoint.sh), so they are
#    left out; nginx gzips index.html as it sends it.
FROM nginx:1.30.5-alpine3.24@sha256:bf3201ab56f23e5954646379c775d511fc466e9f11376d9725361064ad07ed35 AS build
ARG NGX_BROTLI_COMMIT=a71f9312c2deb28875acc7bacfdd5695a111aa53
RUN apk add --no-cache gcc libc-dev make pcre2-dev zlib-dev linux-headers brotli
WORKDIR /src
RUN wget -q "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" \
    && echo "6c20565aa2325cb82216ae804f4a4ff1875179014759a381c42ddc8e11c4906d  nginx-${NGINX_VERSION}.tar.gz" | sha256sum -c - \
    && wget -q -O ngx_brotli.tar.gz "https://codeload.github.com/google/ngx_brotli/tar.gz/${NGX_BROTLI_COMMIT}" \
    && echo "1d21be34f3b7b6d05a8142945e59b3a47665edcdfe0f3ee3d3dbef121f90c08c  ngx_brotli.tar.gz" | sha256sum -c - \
    && tar xzf "nginx-${NGINX_VERSION}.tar.gz" && tar xzf ngx_brotli.tar.gz \
    && cd "nginx-${NGINX_VERSION}" \
    && ./configure --with-compat --add-dynamic-module="../ngx_brotli-${NGX_BROTLI_COMMIT}/static" >/dev/null \
    && make modules >/dev/null \
    && cp objs/ngx_http_brotli_static_module.so /src/
COPY dist /dist
RUN cd /dist && find . -type f -size +1k \
        \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' -o -name '*.svg' -o -name '*.json' \
           -o -name '*.webmanifest' -o -name '*.wasm' -o -name '*.map' -o -name '*.txt' -o -name '*.xml' \) \
        ! -path ./index.html ! -path ./assets/js/env.js -print0 \
    | xargs -0 -r -n 8 -P "$(nproc)" sh -c 'for f; do brotli -q 11 -k -f "$f" && gzip -9 -c "$f" > "$f.gz"; done' sh

FROM nginx:1.30.5-alpine3.24@sha256:bf3201ab56f23e5954646379c775d511fc466e9f11376d9725361064ad07ed35
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic
COPY --from=build /src/ngx_http_brotli_static_module.so /usr/lib/nginx/modules/
RUN sed -i '1i load_module modules/ngx_http_brotli_static_module.so;' /etc/nginx/nginx.conf
# The build this image is, served back as X-Web-Build (nginx.conf) so a deploy can tell WHICH image answered
# and not merely that something did. docker-release.sh bakes the content-addressed tag in on seeing this ARG.
ARG BUILD_ID=unreleased
ENV WEB_BUILD=$BUILD_ID
# Staged as a template, not dropped straight into conf.d — the entrypoint renders it. Also NOT into the base
# image's /etc/nginx/templates/, whose auto-envsubst runs with no variable filter and would blank every $uri.
COPY nginx.conf /etc/nginx/default.conf.template
# --chmod because CMD execs this directly: the source file's mode is whatever the checkout gave it, and the
# monorepo restructure landed it 0644 — which the image only reveals at container start, as a crash loop.
COPY --chmod=0755 entrypoint.sh /entrypoint.sh
COPY --from=build /dist /usr/share/nginx/html
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
