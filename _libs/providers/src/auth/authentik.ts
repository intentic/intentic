import type { Provider, ResolvedInputs } from "@intentic/engine";
import { HASH_KEY } from "@intentic/graph";
import { envLine, shellQuote } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { composeDown, composeUp, containerImage, containerLabel, stateDir, waitReady } from "../core/backing-ssh.js";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { listStampedContainers } from "../core/list-stamped.js";
import type { SshSession } from "../core/ssh.js";
import { type SshExecutor, sshExecutor } from "../core/ssh.js";

const KIND = "authentik";
// Authentik runs DB migrations on first boot, so allow a generous readiness window.
const READY_TIMEOUT_MS = 300_000;

const authentikSchema = sshSchema.extend({
    internalIp: z.string(),
    // The host port the server's HTTP (9000) is published on (resolver-assigned, disjoint per instance).
    publishPort: z.number(),
    domain: z.string(),
    secretKey: z.string(),
    bootstrapToken: z.string(),
    bootstrapPassword: z.string(),
    dbPassword: z.string(),
    image: z.string(),
    pgImage: z.string(),
    redisImage: z.string(),
    // Never pruned while true (the engine's protect convention); stamped so orphan pruning honors it too.
    protect: z.boolean().default(false),
});
type AuthentikInputs = z.infer<typeof authentikSchema>;
const parse = (inputs: ResolvedInputs): AuthentikInputs => parseInputs(authentikSchema, inputs, KIND);

const internalUrl = (parsed: AuthentikInputs): string => `http://${parsed.internalIp}:${parsed.publishPort}`;
const outputsFor = (parsed: AuthentikInputs): Record<string, unknown> => ({
    url: `https://${parsed.domain}`,
    issuerUrl: `https://${parsed.domain}/application/o/`,
    internalUrl: internalUrl(parsed),
});

// Authentik as a self-contained compose stack: its own Postgres + Redis (Valkey) + the server (HTTP, stamped
// intentic.id=<id>) + the worker. Image refs are the fully-pinned inputs inlined into the YAML so a bump
// recreates the changed service on the next `up -d`; the AUTHENTIK_* secrets are interpolated from the
// write-once .env beside it.
const composeYaml = (id: string, hash: string, parsed: AuthentikInputs): string =>
    [
        "services:",
        "  postgresql:",
        `    image: ${parsed.pgImage}`,
        "    restart: unless-stopped",
        "    environment: { POSTGRES_USER: authentik, POSTGRES_DB: authentik, POSTGRES_PASSWORD: $AUTHENTIK_POSTGRESQL__PASSWORD }",
        "    volumes: [ database:/var/lib/postgresql ]",
        "    healthcheck: { test: [ CMD-SHELL, pg_isready -U authentik ], interval: 10s, timeout: 5s, retries: 10 }",
        "  redis:",
        `    image: ${parsed.redisImage}`,
        "    restart: unless-stopped",
        '    command: [ "--save", "60", "1", "--loglevel", "warning" ]',
        "    volumes: [ redis:/data ]",
        '    healthcheck: { test: [ CMD-SHELL, "valkey-cli ping | grep -q PONG" ], interval: 10s, timeout: 5s, retries: 10 }',
        "  server:",
        `    image: ${parsed.image}`,
        "    restart: unless-stopped",
        "    command: server",
        "    env_file: ./.env",
        `    ports: [ "${parsed.publishPort}:9000" ]`,
        "    volumes: [ media:/media, templates:/templates ]",
        "    depends_on: { postgresql: { condition: service_healthy }, redis: { condition: service_healthy } }",
        `    labels: [ "intentic.id=${id}", "intentic.type=${KIND}", "intentic.hash=${hash}"${parsed.protect ? ', "intentic.protect=true"' : ""} ]`,
        "  worker:",
        `    image: ${parsed.image}`,
        "    restart: unless-stopped",
        "    command: worker",
        "    env_file: ./.env",
        "    volumes: [ media:/media, certs:/certs, templates:/templates, /var/run/docker.sock:/var/run/docker.sock ]",
        "    depends_on: { postgresql: { condition: service_healthy }, redis: { condition: service_healthy } }",
        "volumes: { database: {}, redis: {}, media: {}, certs: {}, templates: {} }",
        "",
    ].join("\n");

// Write compose (always) + the .env (once — the secret key + bootstrap creds + DB password are baked in on
// first init; re-keying would break sessions / the bootstrap token the bindings reuse). Each line is a
// separate printf arg so one KEY=value lands per line (the komodo .env pattern).
const ensureFiles = async (session: SshSession, id: string, hash: string, parsed: AuthentikInputs): Promise<void> => {
    const dir = stateDir(KIND, id);
    await session.exec(`mkdir -p ${dir}`);
    await session.exec(`cat > ${dir}/compose.yaml <<'COMPOSE_EOF'\n${composeYaml(id, hash, parsed)}COMPOSE_EOF`);
    // Pairs, not pre-joined `KEY=value` text, because the two layers escape different things and each needs the
    // value on its own: envLine renders the .env line compose reads back, shellQuote carries it through the
    // host shell as one printf argument. Four of these are secrets, and the old bare `'${line}'` gave any of
    // them an apostrophe's worth of shell on this host.
    const envPairs: [string, string][] = [
        ["AUTHENTIK_POSTGRESQL__HOST", "postgresql"],
        ["AUTHENTIK_POSTGRESQL__USER", "authentik"],
        ["AUTHENTIK_POSTGRESQL__NAME", "authentik"],
        ["AUTHENTIK_REDIS__HOST", "redis"],
        ["AUTHENTIK_BOOTSTRAP_EMAIL", `akadmin@${parsed.domain}`],
        ["AUTHENTIK_SECRET_KEY", parsed.secretKey],
        ["AUTHENTIK_POSTGRESQL__PASSWORD", parsed.dbPassword],
        ["AUTHENTIK_BOOTSTRAP_PASSWORD", parsed.bootstrapPassword],
        ["AUTHENTIK_BOOTSTRAP_TOKEN", parsed.bootstrapToken],
    ];
    const envLines = envPairs.map(([key, value]) => shellQuote(envLine(key, value))).join(" ");
    await session.exec(`test -f ${dir}/.env || { printf '%s' ${envLines} > ${dir}/.env && chmod 600 ${dir}/.env; }`);
};

// Probe the server's health endpoint FROM THE HOST over SSH (it publishes 9000 on the host); it answers 2xx
// once migrations are done and it is serving.
const readyProbe = (parsed: AuthentikInputs): string => `wget -q -T 10 -O /dev/null ${internalUrl(parsed)}/-/health/ready/`;

// An Authentik auth backing instance (i.want.auth). read returns the resource once the server answers its
// health endpoint (so a noop re-derives the deterministic url/issuerUrl/internalUrl); diff drives a server
// image-pin bump; apply is idempotent (compose up -d reconciles, the named volumes persist). Per-app OIDC
// clients are the authentik-client binding's job, over the API.
export const createAuthentikProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A dependency of these $ref inputs is still a pending create (plan resolves leniently) —
        // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
        if (hasPendingRef(inputs, "internalIp")) {
            return undefined;
        }
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`authentik "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            const probe = await session.exec(readyProbe(parsed));
            if (probe.code !== 0) {
                return undefined;
            }
            const stampHash = await containerLabel(session, ctx.id, HASH_KEY);
            return {
                outputs: outputsFor(parsed),
                detail: { image: await containerImage(session, ctx.id) },
                ...(stampHash === "" ? {} : { stampHash }),
            };
        } finally {
            await session.dispose();
        }
    },
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        const image = (observed.detail?.["image"] ?? "") as string;
        return image === parsed.image
            ? { action: "noop" }
            : { action: "update", reason: `authentik image differs (running ${image}, want ${parsed.image})` };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await ensureFiles(session, ctx.id, ctx.inputsHash ?? "", parsed);
            await composeUp(session, KIND, ctx.id);
            await waitReady(session, KIND, ctx.id, readyProbe(parsed), READY_TIMEOUT_MS);
            return outputsFor(parsed);
        } finally {
            await session.dispose();
        }
    },
    // Parses only the SSH block, so it works from a removed node's inputs AND a ListedResource's (a host's).
    delete: async (inputs, ctx) => {
        const session = await executor.connect(sshTarget(parseInputs(sshSchema, inputs, KIND)));
        try {
            await composeDown(session, KIND, ctx.id);
        } finally {
            await session.dispose();
        }
    },
    list: (sources, ctx) => listStampedContainers(executor, KIND, sources, ctx.log),
});
