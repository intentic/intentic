// The single authority for every docker image intentic deploys. Each third-party value is a fully immutable
// reference — `repo:tag@sha256:digest` — so an upstream re-push of a tag can never silently change what runs; the
// first-party `sandbox` (below) is the deliberate exception, tracking a moving `stable` release tag. Only a
// commit that edits this file (by hand or a merged Renovate PR) moves a version. The resolver reads these
// and emits them as resource INPUTS into the desired-state graph, so the deployed version is recorded in
// desired-state.json: git-reviewable, diffable, and reconciled (a changed pin makes the provider's `diff`
// report drift and `apply` recreate on the new image). Rollback is `git revert` + re-apply.
//
// Renovate is pointed at this file (see renovate.json5) with pinDigests on, so it bumps both the tag and the
// `@sha256:` digest on each pinned third-party entry from the `renovate:` hint comment above it. The first-party
// `sandbox` carries no hint and no digest — it is unpinned (see its note below), so no manager touches it.
//
// SigNoz caveat: the SigNoz stack (signoz/clickhouse/otel/zookeeper) is an interdependent set whose compose +
// collector + clickhouse configs in signoz.ts mirror SigNoz's reference deploy/docker. They are pinned to the
// v0.129.0 reference — the NEWEST SigNoz release that still ships a reference compose (v0.130+ dropped compose
// self-hosting in favour of "Foundry"). A SigNoz bump is therefore a dedicated migration that re-ports those
// configs from the matching tag, grouped by Renovate — not an incidental pin bump — and upstream has
// deprecated this deployment mode, so treat the whole stack as e2e-validated and pinned deliberately.
export const IMAGES = Object.freeze({
    // renovate: datasource=docker depName=codeberg.org/forgejo/forgejo
    forgejo: "codeberg.org/forgejo/forgejo:15.0.3@sha256:55bb42bec9abef5223744804f164e37d37b20df7e8b8b4807ba213ad4f071d6d",
    // renovate: datasource=docker depName=data.forgejo.org/forgejo/runner
    forgejoRunner: "data.forgejo.org/forgejo/runner:12.12.0@sha256:268ad0d1d24bd7ecf2386b7c44e8211398dc014ca81d4fd5fbad96fe79af18f5",
    // The image act_runner runs each `runs-on: docker` job in (carries node; the docker CLI + buildx are
    // bind-mounted from the host by the runner provider). renovate: datasource=docker depName=data.forgejo.org/oci/node
    forgejoRunnerJob: "data.forgejo.org/oci/node:24-bookworm@sha256:fdddfb3e688158251943d52eba361de991548f6814007acba4917ae6b512d6be",
    // renovate: datasource=docker depName=cloudflare/cloudflared
    cloudflared: "cloudflare/cloudflared:2026.6.1@sha256:6d91c121b803126f7a5344005d17a9324788fc09d305b6e2560ec6040a7ae283",
    // renovate: datasource=docker depName=ghcr.io/moghtech/komodo-core
    komodoCore: "ghcr.io/moghtech/komodo-core:2.1.0@sha256:4915d91b5c6e9de4e8fd59391eed5cad090ec84dcf6a1a9233d97edfdbbb88e7",
    // renovate: datasource=docker depName=ghcr.io/moghtech/komodo-periphery
    komodoPeriphery: "ghcr.io/moghtech/komodo-periphery:2.1.0@sha256:f5b272e3d9acd60d4eac69ea4fa0292dcaddfdecfc2be64ba5575e5ae18e72ae",
    // renovate: datasource=docker depName=ghcr.io/ferretdb/ferretdb
    ferretdb: "ghcr.io/ferretdb/ferretdb:2.7.0@sha256:5706414241eb84f0515512c37b46db0f1b1eac9e5ceb7e4c2523211c184b1985",
    // The documentdb-extended postgres FerretDB runs on; its tag is paired with the FerretDB version above.
    // renovate: datasource=docker depName=ghcr.io/ferretdb/postgres-documentdb
    postgresDocumentdb:
        "ghcr.io/ferretdb/postgres-documentdb:17-0.107.0-ferretdb-2.7.0@sha256:2386795ec2aa7ae559304361979f1dc5708d383ee9020ae63dadc2940dfe58f7",
    // The SigNoz stack, pinned to the v0.129.0 reference deploy/docker set (the newest SigNoz release that
    // still ships a reference compose; v0.130 dropped compose self-hosting). ClickHouse is the non-alpine tag
    // SigNoz tests against, paired with a separate ZooKeeper; the migrator runs from the otel-collector image.
    // renovate: datasource=docker depName=clickhouse/clickhouse-server
    clickhouse: "clickhouse/clickhouse-server:25.5.6@sha256:4536143e22dc9bddb217c7e610f6b7ed5e6efd8fefdbc61acdeadb5d8022213a",
    // renovate: datasource=docker depName=signoz/signoz
    signoz: "signoz/signoz:v0.129.0@sha256:50447bb4461c075f52b8fe331324db389f7475b0b6abd1f0a4c9ce7ab3967ca8",
    // The OTel collector image; the schema/telemetrystore migrator runs from this same image at v0.129.
    // renovate: datasource=docker depName=signoz/signoz-otel-collector
    signozOtelCollector: "signoz/signoz-otel-collector:v0.144.5@sha256:f9bf94d566055d06581f3befbf361cc26d670f31ad00cb31fda2ec380210c5ec",
    // The ClickHouse coordination ZooKeeper SigNoz's reference uses (a Bitnami-based image). renovate: datasource=docker depName=signoz/zookeeper
    signozZookeeper: "signoz/zookeeper:3.7.1@sha256:fcc4a3288154ccaa3bdb5ae6dc10180c084d29a8a6a26b62ac8e30a8940dc2e6",
    // Paperless-ngx (i.want.service kind "paperless"): document scanning/indexing/archive. Runs on SQLite +
    // the valkey broker below. renovate: datasource=docker depName=ghcr.io/paperless-ngx/paperless-ngx
    paperless: "ghcr.io/paperless-ngx/paperless-ngx:2.20.15@sha256:6c86cad803970ea782683a8e80e7403444c5bf3cf70de63b4d3c8e87500db92f",
    // OpenProject (i.want.service kind "openproject"): the plain all-in-one tag (NOT -slim) — it bundles
    // postgres + memcached + web + worker under supervisord, so the stack is one container.
    // renovate: datasource=docker depName=openproject/openproject
    openproject: "openproject/openproject:17.5.1@sha256:0232048b00657f6b00369376c4f3f36766b288f0d6e16b953e3f04d5c7ee410a",
    // Outline (i.want.service kind "outline"): team wiki. Runs on the postgres + valkey images above, with
    // the Dex OIDC provider below for login. renovate: datasource=docker depName=outlinewiki/outline
    outline: "outlinewiki/outline:1.8.2-0@sha256:b1bc8d1a30949fcbe96e6c802fd6a13f8538fce221e54b0d472e0329e740d160",
    // The OIDC identity provider bundled into the Outline stack (Outline has no local password auth); one
    // static intentic user. renovate: datasource=docker depName=ghcr.io/dexidp/dex
    dex: "ghcr.io/dexidp/dex:v2.41.1@sha256:bc7cfce7c17f52864e2bb2a4dc1d2f86a41e3019f6d42e81d92a301fad0c8a1d",
    // Invoice Ninja (i.want.service kind "invoiceninja"): invoicing. The Octane/FrankenPHP image is
    // self-serving (the -debian variant is php-fpm behind an nginx sidecar); one image runs the app, worker
    // and scheduler roles. MySQL/MariaDB only (no Postgres) — backed by the mariadb below + the valkey
    // below. renovate: datasource=docker depName=invoiceninja/invoiceninja-octane
    invoiceninja: "invoiceninja/invoiceninja-octane:5.13.26@sha256:5cb4d04646e2e554de82f6f07d1e4bcd4c343ba6361207958097ba2eae77879a",
    // The MariaDB backing Invoice Ninja (upstream's sanctioned mysql alternative, LTS line).
    // renovate: datasource=docker depName=mariadb
    mariadb: "mariadb:11.8.8@sha256:efb4959ef2c835cd735dbc388eb9ad6aab0c78dd64febcd51bc17481111890c4",
    // Infisical (i.want.service kind "infisical"): secrets management. The standalone image (frontend +
    // backend in one; DB migrations run on boot) on the postgres + valkey below.
    // renovate: datasource=docker depName=infisical/infisical
    infisical: "infisical/infisical:v0.161.11@sha256:efe2d4fe5f37fb250ce5956ecc4734cc9ab1b50629d97cf7793d54200a18642b",
    // The scheduled-backup container: alpine-based, carries restic + busybox crond. It has no docker CLI, so
    // the backup provider bind-mounts the host's docker binary (the forgejo-runner pattern) for the
    // app-consistent `docker exec` dumps. renovate: datasource=docker depName=restic/restic
    backup: "restic/restic:0.19.0@sha256:7f44e0057b82348597568ea209360762d0b38f8e1dbc8ad859661ac1055e45f2",
    // The Postgres backing instance (i.want.database). Plain upstream postgres; the binding provider creates
    // per-app databases + roles in it via `docker exec … psql`. Also the DB the Authentik auth instance
    // bundles. renovate: datasource=docker depName=postgres
    postgres: "postgres:18.4-alpine@sha256:1b1689b20d16a014a3d195653381cf2caa75a41a92d93b255a9d6ea29fd353aa",
    // The Valkey backing instance (i.want.cache). The binding provider mints a per-app ACL user in it via
    // `docker exec … valkey-cli`. Also the redis-compatible cache the Authentik auth instance bundles.
    // renovate: datasource=docker depName=valkey/valkey
    valkey: "valkey/valkey:9.1.0-alpine@sha256:a35428eba9043cc0b79dbe54100f0c92784f2de00ad09b01182bfb1c5c83d1bd",
    // The Authentik server (i.want.auth). The instance provider runs it as a compose stack (server + worker +
    // the bundled postgres/valkey above); the binding provider mints a per-app OIDC client via its HTTP API.
    // renovate: datasource=docker depName=ghcr.io/goauthentik/server
    authentik: "ghcr.io/goauthentik/server:2026.2.4@sha256:0ed7e84cef9d0051659dba5cf63a860a485f85b3fff698c8d2fff17fa3cbe596",
    // The Garage S3-compatible object store (i.want.objectStorage). Single container; the binding provider
    // mints a per-app bucket + access key via `docker exec … garage`. renovate: datasource=docker depName=dxflrs/garage
    garage: "dxflrs/garage:v2.3.0@sha256:866bd13ed2038ba7e7190e840482bc27234c4afaf77be8cfa439ae088c1e4690",
    // The first-party intentic image built from _apps/sandbox (the AI-agent workspace), published to the repo's
    // GHCR by scripts/publish-images.sh. Deliberately NOT digest-pinned like the entries above: it tracks the
    // moving `stable` tag, which ONLY the release moves (semantic-release's successCmd pushes `<version> stable`),
    // so it always resolves to the newest RELEASE image — our own component, always current, with no pin to bump.
    // Never `:latest`: that tag is the continuous push-to-main build carrying internal version 0.0.0 (unpublished),
    // so a scaffolded intent repo's `pnpm install` of ~0.0.0 deps fails and `intentic init` can't resolve
    // @intentic/graph. `stable` only ever points at a published release, so init resolves. The GHCR package must be
    // public so tenant hosts can pull it. (Trade-off of unpinning: a `stable` move is not a desired-state input
    // change, so the graph-deployed workspace won't auto-recreate on it — connect.sh/ps1 pull `stable` fresh.)
    sandbox: "registry.gitlab.com/radarsu/intentic/sandbox:stable",
} as const);
