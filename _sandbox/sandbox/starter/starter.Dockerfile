# syntax=docker/dockerfile:1
# THE STARTER SITE the sandbox image bakes, built on its own so the image can carry it as a layer that keeps its digest.
# prepare-image-trees.sh builds this with `--output type=local` into .image-out/layers/starter, and the image copies that
# with `COPY --link --from=trees layers/starter/ /` (_sandbox/sandbox/Dockerfile, which says why the starter is baked).
#
# WHY NOT A RUN IN THE IMAGE, as it was. It ran right after the per-commit CLI tree, so it re-ran on every release, and a
# pnpm install is never the same bytes twice: 1.342.0 → 1.344.0 shipped it as a new 189 MB layer (886 MB unpacked) with
# nothing in it changed. Here it still re-runs every time, but normalize-starter.mjs takes out the clocks, pids and temp
# paths pnpm leaves behind, so two builds from the same template and lockfile are the same bytes, on any runner.
#
# The same Node and pnpm as the image, because the install records absolute paths and versions it must find there:
# $PNPM_HOME is the image's, the store is the one the seeded starter pins as its storeDir (src/scaffold/starter-site.ts),
# and pnpm 12 fetches the template's own pnpm into the package-manager store. The FROM line and PNPM_VERSION are held to
# the image's by packs.integration.test.ts and the tool-pins check. Debian trixie on both, so the few native binaries the
# template's packages download match the image's glibc.
FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS build
# git: the scaffold inits the repo it lays down (dropped below; the daemon inits its own). curl: pnpm's installer.
# libatomic1: the template's own pnpm (11, which pnpm 12 fetches for it) is a binary that links it; the image has it
# through g++, a slim base does not.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl libatomic1
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME/bin:$PATH
RUN curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.13.0 SHELL=/bin/sh ENV=/tmp/pnpm-env.sh sh - \
    && rm -f /tmp/pnpm-env.sh \
    && pnpm --version
# The normalizer's one dependency: msgpackr reads and writes pnpm's store index. Pure JS (its native accelerator is
# optional and skipped), outside every path the layer takes.
ARG MSGPACKR_VERSION=2.1.0
RUN --mount=type=cache,target=/root/.npm \
    npm install --prefix /opt/normalize --no-save --no-package-lock --omit=optional --no-audit --no-fund "msgpackr@${MSGPACKR_VERSION}"
COPY normalize-starter.mjs /opt/normalize/normalize-starter.mjs
COPY --from=cli . /opt/intentic-cli
# Built by the SAME CLI the Add-app button runs, so the baked starter and a hand-added landing app cannot drift. One RUN
# from scaffold to normalized layer root: the store and the starter's node_modules are hard links of each other, and
# moving them into /layer inside the layer that made them keeps them so (a move across layers would copy, and ship
# every file twice). The `.git` the scaffold leaves is dropped: the daemon inits the repo itself when it seeds it.
# pnpm's metadata cache is a mount and /tmp a tmpfs, so neither reaches the layer; nor does pnpm-state.json (its
# update-check clock), which is outside what the layer takes. ONE metadata document is kept, apart: the `pnpm` package's
# own. pnpm 12 resolves the project's pinned pnpm through it before it will run the copy already in the
# package-manager store, so without it the seeded starter's first `pnpm` needs the registry (measured: offline, it
# fails "Failed to resolve pnpm@11.9.0"; online, a 1.9 MB fetch). It moves whenever pnpm publishes, so it leaves here
# as its own small tree and the image copies it among the per-commit layers, never into the starter's. Its root/ is 700,
# /root's own mode: a layer's directory entry replaces the one below it, and mkdir would have made it 755.
ARG STARTER_TEMPLATE_REF=main
RUN --mount=type=cache,target=/root/.cache/pnpm \
    --mount=type=tmpfs,target=/tmp \
    node /opt/intentic-cli/dist/cli.js scaffold monorepo --dir /opt --name starter --ref "$STARTER_TEMPLATE_REF" \
    && node /opt/intentic-cli/dist/cli.js scaffold add-app --dir /opt/starter --apps landing --ref "$STARTER_TEMPLATE_REF" \
    && rm -rf /opt/starter/.git \
    && mkdir -p /layer/opt /layer/usr/local/share/pnpm \
    && mv /opt/starter /layer/opt/starter \
    && mv "$PNPM_HOME/store" "$PNPM_HOME/package-manager-store" /layer/usr/local/share/pnpm/ \
    && node --disable-warning=ExperimentalWarning /opt/normalize/normalize-starter.mjs /layer /opt/normalize/node_modules/msgpackr \
    && for doc in /root/.cache/pnpm/v*/metadata/*/pnpm.jsonl; do \
        [ -f "$doc" ] || { echo "no metadata for the pnpm package under /root/.cache/pnpm" >&2; exit 1; }; \
        mkdir -p "/meta$(dirname "$doc")" && cp "$doc" "/meta$doc"; \
    done \
    && chmod 700 /meta/root

FROM scratch
COPY --from=build /layer/ /starter/
COPY --from=build /meta/ /pnpm-metadata/
