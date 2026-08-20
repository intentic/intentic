import type { Provider, ResolvedInputs } from "@intentic/engine";
import { HASH_KEY } from "@intentic/graph";
import { z } from "zod";
import { composeDown, composeUp, containerId, containerImage, containerLabel, stateDir, waitReady } from "../core/backing-ssh.js";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { listStampedContainers } from "../core/list-stamped.js";
import type { SshSession } from "../core/ssh.js";
import { type SshExecutor, sshExecutor } from "../core/ssh.js";

const KIND = "garage";
const READY_TIMEOUT_MS = 120_000;
// The garage binary path inside the dxflrs/garage image (its entrypoint), invoked for status + bootstrap.
const BIN = "/garage";

const garageSchema = sshSchema.extend({
    internalIp: z.string(),
    // The host port the S3 API (3900) is published on (resolver-assigned, disjoint per instance).
    publishPort: z.number(),
    region: z.string(),
    image: z.string(),
    // Set when the store is exposed through Cloudflare; the public `endpoint` output then uses it.
    domain: z.string().optional(),
    // Never pruned while true (the engine's protect convention); stamped so orphan pruning honors it too.
    protect: z.boolean().default(false),
});
type GarageInputs = z.infer<typeof garageSchema>;
const parse = (inputs: ResolvedInputs): GarageInputs => parseInputs(garageSchema, inputs, KIND);

// internalEndpoint is what consuming apps reach host-locally; endpoint is the public S3 URL when exposed.
const internalEndpoint = (parsed: GarageInputs): string => `http://${parsed.internalIp}:${parsed.publishPort}`;
const outputsFor = (parsed: GarageInputs): Record<string, unknown> => ({
    internalEndpoint: internalEndpoint(parsed),
    endpoint: parsed.domain !== undefined ? `https://${parsed.domain}` : internalEndpoint(parsed),
});

// Single-node Garage: SQLite metadata, replication_factor 1, S3 API on 3900 (published), RPC on 3901
// (in-container; the CLI reaches it locally). The RPC secret is read from a host-written file so compose.yaml
// stays rewritable for image-pin bumps. Stamped intentic.id=<id> so the binding can docker-exec the CLI.
const composeYaml = (id: string, hash: string, parsed: GarageInputs): string =>
    [
        "services:",
        "  garage:",
        `    image: ${parsed.image}`,
        "    restart: unless-stopped",
        "    volumes:",
        "      - meta:/var/lib/garage/meta",
        "      - data:/var/lib/garage/data",
        "      - ./garage.toml:/etc/garage.toml:ro",
        "      - ./rpc_secret:/etc/garage/rpc_secret:ro",
        `    ports: [ "${parsed.publishPort}:3900" ]`,
        `    labels: [ "intentic.id=${id}", "intentic.type=${KIND}", "intentic.hash=${hash}"${parsed.protect ? ', "intentic.protect=true"' : ""} ]`,
        "volumes: { meta: {}, data: {} }",
        "",
    ].join("\n");

const garageToml = (parsed: GarageInputs): string =>
    [
        'metadata_dir = "/var/lib/garage/meta"',
        'data_dir = "/var/lib/garage/data"',
        'db_engine = "sqlite"',
        "replication_factor = 1",
        'rpc_bind_addr = "[::]:3901"',
        'rpc_secret_file = "/etc/garage/rpc_secret"',
        "[s3_api]",
        `s3_region = "${parsed.region}"`,
        'api_bind_addr = "[::]:3900"',
        "",
    ].join("\n");

// Write compose + garage.toml (always) and the rpc secret (once — 32 bytes / 64 hex via openssl, host-side).
const ensureFiles = async (session: SshSession, id: string, hash: string, parsed: GarageInputs): Promise<void> => {
    const dir = stateDir(KIND, id);
    await session.exec(`mkdir -p ${dir}`);
    await session.exec(`cat > ${dir}/compose.yaml <<'COMPOSE_EOF'\n${composeYaml(id, hash, parsed)}COMPOSE_EOF`);
    await session.exec(`cat > ${dir}/garage.toml <<'GARAGE_EOF'\n${garageToml(parsed)}GARAGE_EOF`);
    await session.exec(`test -f ${dir}/.env || printf 'TZ=Etc/UTC\\n' > ${dir}/.env`);
    await session.exec(`test -f ${dir}/rpc_secret || { openssl rand -hex 32 > ${dir}/rpc_secret && chmod 600 ${dir}/rpc_secret; }`);
};

const readyProbe = (id: string): string =>
    `cid=$(docker ps -q --filter "label=intentic.id=${id}"); [ -n "$cid" ] && docker exec "$cid" ${BIN} status`;

// Assign the single node a layout role on first boot (idempotent: skip once it already holds one). Without a
// layout, Garage refuses bucket/key operations, so the binding would fail.
const ensureLayout = async (session: SshSession, id: string): Promise<void> => {
    const cid = await containerId(session, id);
    const nodeId = (await session.exec(`docker exec ${cid} ${BIN} node id -q`)).stdout.trim().split("@")[0] ?? "";
    if (nodeId === "") {
        throw new Error(`garage "${id}": could not read node id`);
    }
    const layout = await session.exec(`docker exec ${cid} ${BIN} layout show`);
    if (layout.stdout.includes(nodeId)) {
        return;
    }
    await session.exec(`docker exec ${cid} ${BIN} layout assign -z dc1 -c 1G ${nodeId}`);
    await session.exec(`docker exec ${cid} ${BIN} layout apply --version 1`);
};

// A Garage object-storage backing instance (i.want.objectStorage). read returns the resource once the
// container answers `garage status`; diff drives an image-pin bump; apply is idempotent (compose up -d
// reconciles, the volumes persist, the layout bootstrap is guarded). Per-app buckets are the binding's job.
export const createGarageProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A dependency of these $ref inputs is still a pending create (plan resolves leniently),
        // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
        if (hasPendingRef(inputs, "internalIp")) {
            return undefined;
        }
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`garage "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            const probe = await session.exec(readyProbe(ctx.id));
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
            : { action: "update", reason: `garage image differs (running ${image}, want ${parsed.image})` };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await ensureFiles(session, ctx.id, ctx.inputsHash ?? "", parsed);
            await composeUp(session, KIND, ctx.id);
            await waitReady(session, KIND, ctx.id, readyProbe(ctx.id), READY_TIMEOUT_MS);
            await ensureLayout(session, ctx.id);
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
