// Images are pinned `repo:tag@sha256:digest`; only a commit here moves one, bumped by Renovate via the `renovate:`
// hint above each entry. sandbox is the exception, tracking the moving `stable` tag. SigNoz is pinned to v0.129.0
// (last release with a reference compose); bumping it means re-porting signoz.ts's configs, not a routine pin bump.
export const IMAGES = Object.freeze({
    // renovate: datasource=docker depName=codeberg.org/forgejo/forgejo
    forgejo: "codeberg.org/forgejo/forgejo:15.0.3@sha256:55bb42bec9abef5223744804f164e37d37b20df7e8b8b4807ba213ad4f071d6d",
    // renovate: datasource=docker depName=data.forgejo.org/forgejo/runner
    forgejoRunner: "data.forgejo.org/forgejo/runner:12.12.0@sha256:268ad0d1d24bd7ecf2386b7c44e8211398dc014ca81d4fd5fbad96fe79af18f5",
    // Image act_runner runs `runs-on: docker` jobs in; docker CLI + buildx are bind-mounted from the host.
    // renovate: datasource=docker depName=data.forgejo.org/oci/node
    forgejoRunnerJob: "data.forgejo.org/oci/node:24-bookworm@sha256:fdddfb3e688158251943d52eba361de991548f6814007acba4917ae6b512d6be",
    // renovate: datasource=docker depName=cloudflare/cloudflared
    cloudflared: "cloudflare/cloudflared:2026.8.3@sha256:51c9cefcb4569df44e1ad403ab1d3d8065aa8e84339bcfc6aee75502e1140339",
    // renovate: datasource=docker depName=ghcr.io/moghtech/komodo-core
    komodoCore: "ghcr.io/moghtech/komodo-core:2.1.0@sha256:4915d91b5c6e9de4e8fd59391eed5cad090ec84dcf6a1a9233d97edfdbbb88e7",
    // renovate: datasource=docker depName=ghcr.io/moghtech/komodo-periphery
    komodoPeriphery: "ghcr.io/moghtech/komodo-periphery:2.1.0@sha256:f5b272e3d9acd60d4eac69ea4fa0292dcaddfdecfc2be64ba5575e5ae18e72ae",
    // renovate: datasource=docker depName=ghcr.io/ferretdb/ferretdb
    ferretdb: "ghcr.io/ferretdb/ferretdb:2.7.0@sha256:5706414241eb84f0515512c37b46db0f1b1eac9e5ceb7e4c2523211c184b1985",
    // documentdb-extended postgres FerretDB runs on; tag paired with the FerretDB version above.
    // renovate: datasource=docker depName=ghcr.io/ferretdb/postgres-documentdb
    postgresDocumentdb:
        "ghcr.io/ferretdb/postgres-documentdb:17-0.107.0-ferretdb-2.7.0@sha256:2386795ec2aa7ae559304361979f1dc5708d383ee9020ae63dadc2940dfe58f7",
    // Non-alpine ClickHouse tag SigNoz tests against, paired with a separate ZooKeeper below.
    // renovate: datasource=docker depName=clickhouse/clickhouse-server
    clickhouse: "clickhouse/clickhouse-server:25.5.6@sha256:4536143e22dc9bddb217c7e610f6b7ed5e6efd8fefdbc61acdeadb5d8022213a",
    // renovate: datasource=docker depName=signoz/signoz
    signoz: "signoz/signoz:v0.129.0@sha256:50447bb4461c075f52b8fe331324db389f7475b0b6abd1f0a4c9ce7ab3967ca8",
    // OTel collector image; the schema/telemetrystore migrator also runs from this same image.
    // renovate: datasource=docker depName=signoz/signoz-otel-collector
    signozOtelCollector: "signoz/signoz-otel-collector:v0.144.5@sha256:f9bf94d566055d06581f3befbf361cc26d670f31ad00cb31fda2ec380210c5ec",
    // ClickHouse coordination ZooKeeper SigNoz's reference uses (Bitnami-based).
    // renovate: datasource=docker depName=signoz/zookeeper
    signozZookeeper: "signoz/zookeeper:3.7.1@sha256:fcc4a3288154ccaa3bdb5ae6dc10180c084d29a8a6a26b62ac8e30a8940dc2e6",
    // Paperless-ngx (kind "paperless"): document scanning/archive; runs on SQLite + the valkey broker below.
    // renovate: datasource=docker depName=ghcr.io/paperless-ngx/paperless-ngx
    paperless: "ghcr.io/paperless-ngx/paperless-ngx:2.20.15@sha256:6c86cad803970ea782683a8e80e7403444c5bf3cf70de63b4d3c8e87500db92f",
    // OpenProject: all-in-one tag (not -slim) bundles postgres+memcached+web+worker via supervisord.
    // renovate: datasource=docker depName=openproject/openproject
    openproject: "openproject/openproject:17.5.1@sha256:0232048b00657f6b00369376c4f3f36766b288f0d6e16b953e3f04d5c7ee410a",
    // Outline (kind "outline"): team wiki; runs on the postgres+valkey images above, Dex below for login.
    // renovate: datasource=docker depName=outlinewiki/outline
    outline: "outlinewiki/outline:1.8.2-0@sha256:b1bc8d1a30949fcbe96e6c802fd6a13f8538fce221e54b0d472e0329e740d160",
    // OIDC provider bundled into the Outline stack (no local password auth); one static intentic user.
    // renovate: datasource=docker depName=ghcr.io/dexidp/dex
    dex: "ghcr.io/dexidp/dex:v2.41.1@sha256:bc7cfce7c17f52864e2bb2a4dc1d2f86a41e3019f6d42e81d92a301fad0c8a1d",
    // Invoice Ninja: one Octane/FrankenPHP image runs app/worker/scheduler roles; MySQL/MariaDB only.
    // renovate: datasource=docker depName=invoiceninja/invoiceninja-octane
    invoiceninja: "invoiceninja/invoiceninja-octane:5.13.26@sha256:5cb4d04646e2e554de82f6f07d1e4bcd4c343ba6361207958097ba2eae77879a",
    // MariaDB backing Invoice Ninja; upstream's sanctioned mysql alternative, LTS line.
    // renovate: datasource=docker depName=mariadb
    mariadb: "mariadb:11.8.8@sha256:efb4959ef2c835cd735dbc388eb9ad6aab0c78dd64febcd51bc17481111890c4",
    // Infisical (kind "infisical"): secrets management; standalone image (frontend+backend, migrates on boot).
    // renovate: datasource=docker depName=infisical/infisical
    infisical: "infisical/infisical:v0.161.11@sha256:efe2d4fe5f37fb250ce5956ecc4734cc9ab1b50629d97cf7793d54200a18642b",
    // Scheduled-backup container (alpine, restic+crond); no docker CLI, host's docker binary is bind-mounted.
    // renovate: datasource=docker depName=restic/restic
    backup: "restic/restic:0.19.0@sha256:7f44e0057b82348597568ea209360762d0b38f8e1dbc8ad859661ac1055e45f2",
    // Postgres backing instance; binding provider creates per-app db+role via `docker exec … psql`.
    // renovate: datasource=docker depName=postgres
    postgres: "postgres:18.4-alpine@sha256:1b1689b20d16a014a3d195653381cf2caa75a41a92d93b255a9d6ea29fd353aa",
    // Valkey backing instance; binding provider mints a per-app ACL user via `docker exec … valkey-cli`.
    // renovate: datasource=docker depName=valkey/valkey
    valkey: "valkey/valkey:9.1.0-alpine@sha256:a35428eba9043cc0b79dbe54100f0c92784f2de00ad09b01182bfb1c5c83d1bd",
    // Authentik server (i.want.auth); compose of server+worker+bundled postgres/valkey; OIDC clients via its API.
    // renovate: datasource=docker depName=ghcr.io/goauthentik/server
    authentik: "ghcr.io/goauthentik/server:2026.2.4@sha256:0ed7e84cef9d0051659dba5cf63a860a485f85b3fff698c8d2fff17fa3cbe596",
    // Garage object store (i.want.objectStorage); binding provider mints per-app bucket+key via `docker exec`.
    // renovate: datasource=docker depName=dxflrs/garage
    garage: "dxflrs/garage:v2.3.0@sha256:866bd13ed2038ba7e7190e840482bc27234c4afaf77be8cfa439ae088c1e4690",
    // First-party image tracking the moving `stable` tag (moved only by a release), deliberately not digest-pinned.
    // Never `:latest`: that's the unpublished continuous build (0.0.0), which breaks `pnpm install`/`intentic deploy
    // init`.
    sandbox: "ghcr.io/intentic/sandbox:stable",
} as const);
