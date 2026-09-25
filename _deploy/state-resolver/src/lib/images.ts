// Images are pinned `repo:tag@sha256:digest`; only a commit here moves one, bumped by Renovate via the `renovate:`
// hint above each entry. sandbox is the exception, tracking the moving `stable` tag. SigNoz is pinned to v0.129.0
// (last release with a reference compose); bumping it means re-porting signoz.ts's configs, not a routine pin bump.
export const IMAGES = Object.freeze({
    // renovate: datasource=docker depName=codeberg.org/forgejo/forgejo
    forgejo: "codeberg.org/forgejo/forgejo:15.0.9@sha256:91a5310c86934339e16bd06b6078aada836e3d8935b2d70f6598108cbfaed5d1",
    // renovate: datasource=docker depName=data.forgejo.org/forgejo/runner
    forgejoRunner: "data.forgejo.org/forgejo/runner:13.2.0@sha256:ca3d5eea46004789a175d1369eec6829d3ea9bfbe2011a06625b4bdaa55f7552",
    // Image act_runner runs `runs-on: docker` jobs in; docker CLI + buildx are bind-mounted from the host.
    // renovate: datasource=docker depName=data.forgejo.org/oci/node
    forgejoRunnerJob: "data.forgejo.org/oci/node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4",
    // renovate: datasource=docker depName=cloudflare/cloudflared
    cloudflared: "cloudflare/cloudflared:2026.9.3@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c",
    // renovate: datasource=docker depName=ghcr.io/moghtech/komodo-core
    komodoCore: "ghcr.io/moghtech/komodo-core:2.3.3@sha256:bca73d0eee143066228fb9b80c38a5a2726e573ad2758f7aa92b5c91a8aef1c7",
    // renovate: datasource=docker depName=ghcr.io/moghtech/komodo-periphery
    komodoPeriphery: "ghcr.io/moghtech/komodo-periphery:2.3.3@sha256:fa3f1a641a265216066676950d5eecdf506955a7bafe2f01996135ae93115cd5",
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
    openproject: "openproject/openproject:17.8.0@sha256:8e49371d8d2aa5b92a40231687076fa3eaa2c98ff1f4f1789e1fe9da5fd838f9",
    // Outline (kind "outline"): team wiki; runs on the postgres+valkey images above, Dex below for login.
    // renovate: datasource=docker depName=outlinewiki/outline
    outline: "outlinewiki/outline:1.10.1@sha256:832051f039b446c87aa23929cf92c00980c66aaa2d744d118c48c016ec816ad8",
    // OIDC provider bundled into the Outline stack (no local password auth); one static intentic user.
    // renovate: datasource=docker depName=ghcr.io/dexidp/dex
    dex: "ghcr.io/dexidp/dex:v2.45.1@sha256:8499afd690c437f52301efd2b05b2455da5bd2dfc20332cd697dc9937f808462",
    // Invoice Ninja: one Octane/FrankenPHP image runs app/worker/scheduler roles; MySQL/MariaDB only.
    // renovate: datasource=docker depName=invoiceninja/invoiceninja-octane
    invoiceninja: "invoiceninja/invoiceninja-octane:5.13.43@sha256:e9e5fba61c897102db6ad0be20b688f74dad4ab135fc9717677d466b8ec7bd28",
    // MariaDB backing Invoice Ninja; upstream's sanctioned mysql alternative, LTS line.
    // renovate: datasource=docker depName=mariadb
    mariadb: "mariadb:11.8.9@sha256:79d59758afc91b89b120b0a8904d637f5a3b3e1c4900f29b740d6d46c72fef68",
    // Infisical (kind "infisical"): secrets management; standalone image (frontend+backend, migrates on boot).
    // renovate: datasource=docker depName=infisical/infisical
    infisical: "infisical/infisical:v0.165.16@sha256:6b911e3938ac2ff385a782df59ce9272799be7976d26dc5667266a2aecac4116",
    // Scheduled-backup container (alpine, restic+crond); no docker CLI, host's docker binary is bind-mounted.
    // renovate: datasource=docker depName=restic/restic
    backup: "restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510",
    // Postgres backing instance; binding provider creates per-app db+role via `docker exec … psql`.
    // renovate: datasource=docker depName=postgres
    postgres: "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873",
    // Valkey backing instance; binding provider mints a per-app ACL user via `docker exec … valkey-cli`.
    // renovate: datasource=docker depName=valkey/valkey
    valkey: "valkey/valkey:9.1.2-alpine@sha256:48332870af354a799964c0012ae1194a0bf2bf894eb508f945810596dc2d8d11",
    // Authentik server (i.want.auth); compose of server+worker+bundled postgres/valkey; OIDC clients via its API.
    // renovate: datasource=docker depName=ghcr.io/goauthentik/server
    authentik: "ghcr.io/goauthentik/server:2026.2.7@sha256:da7024c4a7136b2f0fbbae3740c5ed54633edb393b10dc4fae2cdc056b8f70a8",
    // Garage object store (i.want.objectStorage); binding provider mints per-app bucket+key via `docker exec`.
    // renovate: datasource=docker depName=dxflrs/garage
    garage: "dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020",
    // First-party image tracking the moving `stable` tag (moved only by a release), deliberately not digest-pinned.
    // Never `:latest`: that's the unpublished continuous build (0.0.0), which breaks `pnpm install`/`intentic deploy
    // init`.
    sandbox: "ghcr.io/intentic/sandbox:stable",
} as const);
