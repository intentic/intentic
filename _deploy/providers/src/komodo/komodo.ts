import { HOST_STATE_ROOT } from "@intentic/constants";
import { pollUntil } from "@intentic/base/async";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { HASH_KEY } from "@intentic/graph";
import { envLine, shellQuote } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { guardedUpdate } from "../core/guarded-update.js";
import { gitProvider, hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { containerLabel } from "../core/backing-ssh.js";
import { listStampedContainers } from "../core/list-stamped.js";
import { type SshSession, type SshExecutor, sshExecutor } from "../core/ssh.js";

const komodoSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    // Git provider for cloning private repos, Forgejo stack only; gitUrl is Forgejo's internal url.
    gitUrl: z.string().optional(),
    gitAccount: z.string().optional(),
    gitToken: z.string().optional(),
    // Container registry Komodo pulls app images from, written as a [[docker_registry]] account.
    registry: z.string(),
    registryUser: z.string(),
    registryToken: z.string(),
    // Fully-pinned images for the four compose services, written into compose.yaml so a bump recreates on apply.
    coreImage: z.string(),
    peripheryImage: z.string(),
    ferretdbImage: z.string(),
    postgresImage: z.string(),
    // Guarded-update inputs, present only under updatePolicy:"guarded" with a backup.
    guardRepo: z.string().optional(),
    resticImage: z.string().optional(),
});
type KomodoInputs = z.infer<typeof komodoSchema>;
const parse = (inputs: ResolvedInputs): KomodoInputs => parseInputs(komodoSchema, inputs, "komodo");

const CORE = "intentic-komodo-core";
// The fixed host port Core publishes, the port every engine-side Komodo consumer forwards to over SSH.
export const KOMODO_CORE_PORT = 9120;
const STATE_DIR = `${HOST_STATE_ROOT}/komodo`;
const READY_TIMEOUT_MS = 90_000;
const READY_INTERVAL_MS = 3_000;

const internalUrl = (parsed: KomodoInputs): string => `http://${parsed.internalIp}:${KOMODO_CORE_PORT}`;
const outputsFor = (parsed: KomodoInputs): Record<string, unknown> => ({ url: `https://${parsed.domain}`, internalUrl: internalUrl(parsed) });

// Matched by the intentic.id label, not name: compose names it "<project>-core-1", not CORE.
const running = async (session: SshSession, id: string): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "label=intentic.id=${id}" --format '{{.Names}}'`);
    return result.stdout.trim() !== "";
};

// Create-time image of each compose service, keyed by service name; .Config.Image (not docker ps's truncated
// .Image) gives the exact ref written into compose.yaml. Returns {} when the stack is down.
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

// FerretDB + Core + Periphery, co-located so Periphery trusts Core via the shared keys volume. `$...` secrets
// interpolate from the .env beside it; image refs are inlined here (not the .env) so a bump recreates on `up -d`.
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
        // config.toml carries the git-provider account, bound read-only; relative to --project-directory (STATE_DIR).
        "    volumes: [ keys:/config/keys, ./config.toml:/config/config.toml:ro ]",
        `    labels: [ "intentic.id=${id}", "intentic.type=komodo", "intentic.hash=${hash}" ]`,
        // Inbound mode: no core_address, so periphery's listener stays up; PERIPHERY_CORE_ADDRESS would disable it.
        "  periphery:",
        `    image: ${images["periphery"]}`,
        "    restart: unless-stopped",
        // Bind-mounts /proc; masked paths over it hard-fail on WSL2 kernels ("can't mask path /proc/interrupts").
        "    security_opt: [ systempaths=unconfined ]",
        "    volumes: [ /var/run/docker.sock:/var/run/docker.sock, /proc:/proc, keys:/config/keys ]",
        "volumes: { postgres-data: {}, ferretdb-state: {}, keys: {} }",
        "",
    ].join("\n");

// Provider accounts Komodo uses: git_provider (Forgejo stack only) and docker_registry; neither can be set via
// env in Komodo v2, only this file. docker_registry's domain is what image_registry_account selects.
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

// Writes compose.yaml + config.toml every apply, and the .env once, since its secrets must survive restarts.
const ensureFiles = async (session: SshSession, parsed: KomodoInputs, images: Record<string, string>, id: string, hash: string): Promise<void> => {
    await session.exec(`mkdir -p ${STATE_DIR}`);
    await session.exec(`cat > ${STATE_DIR}/compose.yaml <<'COMPOSE_EOF'\n${composeYaml(images, id, hash)}COMPOSE_EOF`);
    await session.exec(`cat > ${STATE_DIR}/config.toml <<'CONFIG_EOF'\n${configToml(parsed)}CONFIG_EOF`);
    // Each line is its own printf argument, since printf %s does not interpret \n and a joined string would print
    // literally. Known-here values go through envLine + shellQuote; only the three host-generated secrets stay in the
    // shell block.
    const envPairs: [string, string][] = [
        ["TZ", "Etc/UTC"],
        ["KOMODO_LOCAL_AUTH", "true"],
        ["KOMODO_CONFIG_PATH", "/config/config.toml"],
        ["KOMODO_INIT_ADMIN_USERNAME", parsed.adminUser],
        ["KOMODO_DATABASE_ADDRESS", "ferretdb:27017"],
        ["KOMODO_FIRST_SERVER_NAME", "Local"],
        ["KOMODO_FIRST_SERVER_ADDRESS", "https://periphery:8120"],
        // How often Komodo polls for a new digest; a CI push goes live within this window even without notify.
        ["KOMODO_RESOURCE_POLL_INTERVAL", "1-min"],
        ["KOMODO_HOST", `https://${parsed.domain}`],
        ["KOMODO_INIT_ADMIN_PASSWORD", parsed.adminPassword],
        ["KOMODO_DATABASE_USERNAME", "komodo"],
    ];
    const staticEnv = envPairs.map(([key, value]) => shellQuote(envLine(key, value))).join(" ");
    // Hex needs no escaping inside single quotes; passed as a printf argument so `%` is never a conversion.
    const generated = [
        `printf "KOMODO_PASSKEY='%s'\\n" "$(openssl rand -hex 32)"`,
        `printf "KOMODO_JWT_SECRET='%s'\\n" "$(openssl rand -hex 32)"`,
        `printf "KOMODO_DATABASE_PASSWORD='%s'\\n" "$(openssl rand -hex 16)"`,
    ].join("; ");
    await session.exec(`test -f ${STATE_DIR}/.env || { printf '%s' ${staticEnv} > ${STATE_DIR}/.env; { ${generated}; } >> ${STATE_DIR}/.env; }`);
};

// Probes Core from the host over SSH, since the engine's network may not reach the host's internal ip. Core
// has no health route; it answers 200 on / once up and connected to the database.
const healthy = async (session: SshSession, parsed: KomodoInputs): Promise<boolean> => {
    const result = await session.exec(`wget -q -T 10 -O /dev/null ${internalUrl(parsed)}`);
    return result.code === 0;
};

const waitHealthy = async (session: SshSession, parsed: KomodoInputs): Promise<void> => {
    const up = await pollUntil(() => healthy(session, parsed), { timeoutMs: READY_TIMEOUT_MS, intervalMs: READY_INTERVAL_MS });
    if (!up) {
        throw new Error(`komodo did not become healthy within ${READY_TIMEOUT_MS}ms`);
    }
};

// Komodo (deploy orchestrator) as a co-located FerretDB + Core + Periphery compose stack. `read` gates on Core's
// health check; `apply` is idempotent via `docker compose up -d`. No passkey/apiKey output; notify uses admin login.
export const createKomodoProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A pending dependency means this resource cannot be introspected yet; parsing would crash on the symbol.
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
    // `up -d` recreates only services whose pinned image changed; named volumes survive, so a bump is a safe in-place
    // update.
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
            // Renders compose, runs `up -d`, and waits healthy; throws if it never comes up.
            // --env-file/--project-directory
            // pin the .env we wrote, or compose looks in the SSH working dir and leaves the $secrets blank.
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
            // A guarded version bump wraps recreate in a snapshot + health-gate + rollback transaction.
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
    // Parses only the SSH block, so it works from a removed node's inputs or a ListedResource's.
    delete: async (inputs) => {
        const session = await executor.connect(sshTarget(parseInputs(sshSchema, inputs, "komodo")));
        try {
            // `down -v` drops the stack and its named volumes; then the host-side compose + secrets dir is removed too.
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
