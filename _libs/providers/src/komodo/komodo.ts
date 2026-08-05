import { setTimeout as sleep } from "node:timers/promises";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { HASH_KEY } from "@intentic/graph";
import { envLine, shellQuote } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { guardedUpdate } from "../core/guarded-update.js";
import { gitProvider, hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { containerLabel } from "../core/backing-ssh.js";
import { listStampedContainers } from "../core/list-stamped.js";
import type { SshSession } from "../core/ssh.js";
import { type SshExecutor, sshExecutor } from "../core/ssh.js";

const komodoSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    // The git provider Komodo authenticates to when cloning the admin's private app repos — present only on
    // the Forgejo stack. gitUrl is the INTERNAL Forgejo url (http://<internalIp>:3000); Komodo clones the
    // repos from inside the host's Docker, so the git-provider account is registered against this internal
    // authority (the public git.<zone> name does not resolve there). The hosted forges (GitHub/GitLab) omit
    // the trio: their deployments are registry Images Komodo never clones.
    gitUrl: z.string().optional(),
    gitAccount: z.string().optional(),
    gitToken: z.string().optional(),
    // The container registry Komodo PULLS app images from (the Forgejo built-in registry, ghcr.io, or the
    // GitLab Container Registry) — written as a [[docker_registry]] account so a private image can be pulled.
    registry: z.string(),
    registryUser: z.string(),
    registryToken: z.string(),
    // The fully-pinned images for the four compose services. Written into the compose YAML literal (not the
    // write-once .env), so a version bump lands on the next apply and `docker compose up -d` recreates the
    // changed service; read observes each running image and diff drives the update.
    coreImage: z.string(),
    peripheryImage: z.string(),
    ferretdbImage: z.string(),
    postgresImage: z.string(),
    // Guarded-update inputs, present only when the host opted into updatePolicy:"guarded" + declared a backup.
    // A version bump then snapshots the data volumes, recreates, health-gates, and rolls images + data back on
    // failure. The restic password/creds come from the on-host restic.env the backup provider writes.
    guardRepo: z.string().optional(),
    resticImage: z.string().optional(),
});
type KomodoInputs = z.infer<typeof komodoSchema>;
const parse = (inputs: ResolvedInputs): KomodoInputs => parseInputs(komodoSchema, inputs, "komodo");

const CORE = "intentic-komodo-core";
// The fixed host port Core publishes — the port every engine-side Komodo consumer forwards to over SSH.
export const KOMODO_CORE_PORT = 9120;
const STATE_DIR = "/opt/intentic/komodo";
const READY_TIMEOUT_MS = 90_000;
const READY_INTERVAL_MS = 3_000;

const internalUrl = (parsed: KomodoInputs): string => `http://${parsed.internalIp}:${KOMODO_CORE_PORT}`;
const outputsFor = (parsed: KomodoInputs): Record<string, unknown> => ({ url: `https://${parsed.domain}`, internalUrl: internalUrl(parsed) });

// docker compose names the core container "<project>-core-1", not CORE, so match it by the intentic.id
// label the compose stamps on it instead of by an exact container name.
const running = async (session: SshSession, id: string): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "label=intentic.id=${id}" --format '{{.Names}}'`);
    return result.stdout.trim() !== "";
};

// The create-time image of each compose service, keyed by its compose service name. Inspecting .Config.Image
// (not `docker ps`'s truncated .Image) returns the exact repo:tag@sha256 ref written into compose.yaml, so a
// bump there reads as drift here. Returns {} when the stack is down.
const PROJECT = "komodo";
const runningImages = async (session: SshSession): Promise<Record<string, string>> => {
    const result = await session.exec(
        `ids=$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}"); ` +
            `[ -n "$ids" ] && docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}={{.Config.Image}}' $ids || true`,
    );
    const images: Record<string, string> = {};
    for (const line of result.stdout.trim().split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
            images[line.slice(0, eq)] = line.slice(eq + 1);
        }
    }
    return images;
};

// Map each compose service to its desired pinned image, so diff can report exactly which one drifted.
const desiredImages = (parsed: KomodoInputs): Record<string, string> => ({
    postgres: parsed.postgresImage,
    ferretdb: parsed.ferretdbImage,
    core: parsed.coreImage,
    periphery: parsed.peripheryImage,
});

// FerretDB + Core + Periphery, co-located so Periphery trusts Core via the shared keys volume (no
// onboarding key needed for a single host). Written verbatim over SSH; the $... secrets are interpolated by
// docker compose from the .env beside it. Image refs are the fully-pinned inputs inlined into the YAML (NOT
// the write-once .env) so a bump recreates the service on the next `up -d`.
const composeYaml = (images: Record<string, string>, id: string, hash: string): string =>
    [
        "services:",
        "  postgres:",
        `    image: ${images["postgres"]}`,
        "    restart: unless-stopped",
        "    environment: { POSTGRES_USER: $KOMODO_DATABASE_USERNAME, POSTGRES_PASSWORD: $KOMODO_DATABASE_PASSWORD, POSTGRES_DB: postgres }",
        "    volumes: [ postgres-data:/var/lib/postgresql/data ]",
        "  ferretdb:",
        `    image: ${images["ferretdb"]}`,
        "    restart: unless-stopped",
        "    depends_on: [ postgres ]",
        "    environment: { FERRETDB_POSTGRESQL_URL: postgres://$KOMODO_DATABASE_USERNAME:$KOMODO_DATABASE_PASSWORD@postgres:5432/postgres }",
        "    volumes: [ ferretdb-state:/state ]",
        "  core:",
        `    image: ${images["core"]}`,
        "    restart: unless-stopped",
        "    depends_on: [ ferretdb ]",
        `    ports: [ "${KOMODO_CORE_PORT}:9120" ]`,
        "    env_file: ./.env",
        // config.toml carries the git-provider account (Komodo clones private app repos with it); bind it in
        // read-only. Relative to --project-directory (STATE_DIR), so it resolves to the file ensureFiles writes.
        "    volumes: [ keys:/config/keys, ./config.toml:/config/config.toml:ro ]",
        `    labels: [ "intentic.id=${id}", "intentic.type=komodo", "intentic.hash=${hash}" ]`,
        // INBOUND-mode agent: with no core_address set, periphery keeps its default 8120 listener (SSL on,
        // self-signed cert auto-generated) that Core dials at https://periphery:8120. Setting
        // PERIPHERY_CORE_ADDRESS would flip it to outbound mode and DISABLE that listener (Core's dial would
        // be refused). Co-located on this private compose network, the shared keys volume persists each side's
        // Noise keypair and the handshake needs no pre-shared passkey or pinned core key.
        "  periphery:",
        `    image: ${images["periphery"]}`,
        "    restart: unless-stopped",
        // periphery deliberately bind-mounts the host's /proc (system stats), so docker's default masked
        // paths are theater here — and masking over a bind-mounted /proc hard-fails on WSL2 kernels
        // ("can't mask path /proc/interrupts"), leaving periphery permanently unable to start. Unconfine.
        "    security_opt: [ systempaths=unconfined ]",
        "    volumes: [ /var/run/docker.sock:/var/run/docker.sock, /proc:/proc, keys:/config/keys ]",
        "volumes: { postgres-data: {}, ferretdb-state: {}, keys: {} }",
        "",
    ].join("\n");

// The provider accounts Komodo uses: a git_provider (to clone private app repos — Forgejo stack only) and a
// docker_registry (to pull the private app images CI pushes). Neither can be configured via env in Komodo
// v2 — only via this config file (or the UI/API) — so both are mounted into Core. The docker_registry domain
// is the registry authority the deployment's image_registry_account selects.
const configToml = (parsed: KomodoInputs): string => {
    const lines: string[] = [];
    if (parsed.gitUrl !== undefined && parsed.gitAccount !== undefined && parsed.gitToken !== undefined) {
        const git = gitProvider(parsed.gitUrl);
        lines.push(
            "[[git_provider]]",
            `domain = "${git.domain}"`,
            `https = ${git.https}`,
            `accounts = [{ username = "${parsed.gitAccount}", token = "${parsed.gitToken}" }]`,
            "",
        );
    }
    lines.push(
        "[[docker_registry]]",
        `domain = "${parsed.registry}"`,
        `accounts = [{ username = "${parsed.registryUser}", token = "${parsed.registryToken}" }]`,
        "",
    );
    return lines.join("\n");
};

// Write the compose file + provider config.toml (always) and the .env (once — Core/Periphery secrets must
// survive restarts). passkey/jwt/db secrets are host-generated once and never surface as outputs.
const ensureFiles = async (session: SshSession, parsed: KomodoInputs, images: Record<string, string>, id: string, hash: string): Promise<void> => {
    await session.exec(`mkdir -p ${STATE_DIR}`);
    await session.exec(`cat > ${STATE_DIR}/compose.yaml <<'COMPOSE_EOF'\n${composeYaml(images, id, hash)}COMPOSE_EOF`);
    await session.exec(`cat > ${STATE_DIR}/config.toml <<'CONFIG_EOF'\n${configToml(parsed)}CONFIG_EOF`);
    // Each line is a separate printf argument so one KEY=value lands per line. Joining with "\n" into a single
    // arg would print the literal characters \n (printf %s does not interpret escapes), leaving compose unable
    // to parse the file — the image tags would come through blank.
    //
    // Everything whose value is known HERE goes through envLine + shellQuote, including the admin password and
    // domain that used to ride in `echo "KEY=${value}"` — a double-quoted shell string, where a `$(…)` in
    // either ran on the host at deploy time. Only the three values the HOST generates stay in the shell block,
    // because only they need a substitution to happen over there.
    const envPairs: [string, string][] = [
        ["TZ", "Etc/UTC"],
        ["KOMODO_LOCAL_AUTH", "true"],
        ["KOMODO_CONFIG_PATH", "/config/config.toml"],
        ["KOMODO_INIT_ADMIN_USERNAME", parsed.adminUser],
        ["KOMODO_DATABASE_ADDRESS", "ferretdb:27017"],
        ["KOMODO_FIRST_SERVER_NAME", "Local"],
        ["KOMODO_FIRST_SERVER_ADDRESS", "https://periphery:8120"],
        // How often Komodo polls a deployment's registry tag for a new digest; with auto_update set, a CI push
        // goes live within this window even if the workflow's notify step is unavailable.
        ["KOMODO_RESOURCE_POLL_INTERVAL", "1-min"],
        ["KOMODO_HOST", `https://${parsed.domain}`],
        ["KOMODO_INIT_ADMIN_PASSWORD", parsed.adminPassword],
        ["KOMODO_DATABASE_USERNAME", "komodo"],
    ];
    const staticEnv = envPairs.map(([key, value]) => shellQuote(envLine(key, value))).join(" ");
    // Host-generated secrets: hex, so the single quotes are the .env delimiter and nothing needs escaping
    // inside them. The value is passed as a printf ARGUMENT rather than spliced into the format string, so a
    // `%` in a future generator can never be read as a conversion.
    const generated = [
        `printf "KOMODO_PASSKEY='%s'\\n" "$(openssl rand -hex 32)"`,
        `printf "KOMODO_JWT_SECRET='%s'\\n" "$(openssl rand -hex 32)"`,
        `printf "KOMODO_DATABASE_PASSWORD='%s'\\n" "$(openssl rand -hex 16)"`,
    ].join("; ");
    await session.exec(`test -f ${STATE_DIR}/.env || { printf '%s' ${staticEnv} > ${STATE_DIR}/.env; { ${generated}; } >> ${STATE_DIR}/.env; }`);
};

// Probe Core FROM THE HOST over SSH (Core publishes 9120 on the host), so the check works regardless of
// whether the engine's own network can reach the host's internal ip. Core has no dedicated health route;
// it answers 200 on / once it is up and connected to the database, which is exactly the liveness we want.
const healthy = async (session: SshSession, parsed: KomodoInputs): Promise<boolean> => {
    const result = await session.exec(`wget -q -T 10 -O /dev/null ${internalUrl(parsed)}`);
    return result.code === 0;
};

const waitHealthy = async (session: SshSession, parsed: KomodoInputs): Promise<void> => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
        if (await healthy(session, parsed)) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(`komodo did not become healthy within ${READY_TIMEOUT_MS}ms`);
        }
        await sleep(READY_INTERVAL_MS);
    }
};

// Komodo (the deploy orchestrator) as a co-located FerretDB + Core + Periphery compose stack on the host.
// read returns the resource only when Core is up and answering /api/health (so a noop re-derives the
// deterministic url/internalUrl); diff is a noop. apply is idempotent: secrets persist host-side and
// `docker compose up -d` reconciles the stack. No passkey/apiKey output — the CD-notify provider
// authenticates by admin login.
export const createKomodoProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A dependency of these $ref inputs is still a pending create (plan resolves leniently) —
        // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
        if (hasPendingRef(inputs, "internalIp", "gitUrl", "gitAccount", "gitToken", "registry", "registryUser", "registryToken")) {
            return undefined;
        }
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`komodo "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            if (!(await running(session, ctx.id)) || !(await healthy(session, parsed))) {
                return undefined;
            }
            const stampHash = await containerLabel(session, ctx.id, HASH_KEY);
            return { outputs: outputsFor(parsed), detail: { images: await runningImages(session) }, ...(stampHash === "" ? {} : { stampHash }) };
        } finally {
            await session.dispose();
        }
    },
    // `up -d` recreates only the services whose pinned image in compose.yaml changed; the named volumes
    // (postgres-data/ferretdb-state/keys) survive, so a bump is a safe in-place update gated on health.
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        const images = (observed.detail?.["images"] ?? {}) as Record<string, string>;
        for (const [service, desired] of Object.entries(desiredImages(parsed))) {
            if (images[service] !== desired) {
                return { action: "update", reason: `komodo ${service} image differs (running ${String(images[service])}, want ${desired})` };
            }
        }
        return { action: "noop" };
    },
    apply: async (inputs, observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            // Render compose with a given image set + `up -d` + wait healthy; throws if the stack never gets
            // healthy. --env-file/--project-directory pin the .env we wrote as the interpolation source for the
            // $secrets in compose.yaml and the core service's runtime env; without them compose looks in the
            // SSH working dir, leaving them blank.
            const bringUp = async (images: Record<string, string>): Promise<void> => {
                await ensureFiles(session, parsed, images, ctx.id, ctx.inputsHash ?? "");
                const up = await session.exec(
                    `docker compose -p komodo --project-directory ${STATE_DIR} --env-file ${STATE_DIR}/.env -f ${STATE_DIR}/compose.yaml up -d`,
                );
                if (up.code !== 0) {
                    throw new Error(`failed to bring up komodo stack: exited ${up.code}: ${up.stderr.trim()}`);
                }
                await waitHealthy(session, parsed);
            };
            // On a guarded version bump (existing stack + a backup repo), wrap the recreate in a snapshot +
            // health-gate + image/data rollback transaction; otherwise just bring up the desired images.
            const oldImages = observed?.detail?.["images"];
            if (
                observed !== undefined &&
                parsed.guardRepo !== undefined &&
                parsed.resticImage !== undefined &&
                typeof oldImages === "object" &&
                oldImages !== null
            ) {
                await guardedUpdate({
                    session,
                    repo: parsed.guardRepo,
                    resticImage: parsed.resticImage,
                    volumes: ["komodo_postgres-data", "komodo_keys", "komodo_ferretdb-state"],
                    tag: `intentic-preupdate-${CORE}`,
                    recreate: () => bringUp(desiredImages(parsed)),
                    stop: async () => {
                        await session.exec(
                            'ids=$(docker ps -aq -f label=com.docker.compose.project=komodo); [ -n "$ids" ] && docker rm -f $ids || true',
                        );
                    },
                    rollback: () => bringUp(oldImages as Record<string, string>),
                    log: ctx.log,
                });
            } else {
                await bringUp(desiredImages(parsed));
            }
            return outputsFor(parsed);
        } finally {
            await session.dispose();
        }
    },
    // Parses only the SSH block, so it works from a removed node's inputs AND a ListedResource's (a host's).
    delete: async (inputs) => {
        const session = await executor.connect(sshTarget(parseInputs(sshSchema, inputs, "komodo")));
        try {
            // `down -v` stops the stack and drops its named volumes (postgres/ferretdb/keys); then remove the
            // host-side compose + secrets dir. Tolerant of a stack that is already gone.
            await session.exec(
                `docker compose -p komodo --project-directory ${STATE_DIR} --env-file ${STATE_DIR}/.env -f ${STATE_DIR}/compose.yaml down -v 2>/dev/null || true`,
            );
            await session.exec(`rm -rf ${STATE_DIR}`);
        } finally {
            await session.dispose();
        }
    },
    list: (sources, ctx) => listStampedContainers(executor, "komodo", sources, ctx.log),
});
