import type { Provider } from "@intentic/engine";
import { z } from "zod";
import { backingSchema, createBackingProvider } from "../core/backing-provider.js";
import { containerId, execProbe, stampLabels } from "../core/backing-ssh.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

const KIND = "garage";
// The garage binary path inside the dxflrs/garage image (its entrypoint), invoked for status + bootstrap.
const BIN = "/garage";

const garageSchema = backingSchema.extend({
    region: z.string(),
    // Set when the store is exposed through Cloudflare; the public `endpoint` output then uses it.
    domain: z.string().optional(),
});
type GarageInputs = z.infer<typeof garageSchema>;

// internalEndpoint is what consuming apps reach host-locally; endpoint is the public S3 URL when exposed.
const internalEndpoint = (parsed: GarageInputs): string => `http://${parsed.internalIp}:${parsed.publishPort}`;

// Single-node Garage: SQLite metadata, replication_factor 1, S3 API on 3900 (published), RPC on 3901
// (in-container; the CLI reaches it locally). The RPC secret is read from a host-written file so compose.yaml
// stays rewritable for image-pin bumps. Stamped intentic.id=<id> so the binding can docker-exec the CLI.
const composeYaml = (parsed: GarageInputs, id: string, hash: string): string =>
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
        stampLabels(KIND, id, hash, parsed.protect),
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
export const createGarageProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createBackingProvider(
        {
            kind: KIND,
            schema: garageSchema,
            readyTimeoutMs: 120_000,
            outputs: (parsed) => ({
                internalEndpoint: internalEndpoint(parsed),
                endpoint: parsed.domain !== undefined ? `https://${parsed.domain}` : internalEndpoint(parsed),
            }),
            files: (parsed, id, hash) => ({ "compose.yaml": composeYaml(parsed, id, hash), "garage.toml": garageToml(parsed) }),
            // The RPC secret is 32 bytes of host-generated hex, written once: it is baked into the cluster's
            // identity, so a rewrite would leave the node unable to talk to itself.
            prepare: async (session, _parsed, dir) => {
                await session.exec(`test -f ${dir}/rpc_secret || { openssl rand -hex 32 > ${dir}/rpc_secret && chmod 600 ${dir}/rpc_secret; }`);
            },
            probe: (_parsed, id) => execProbe(id, `${BIN} status`),
            ready: (session, _parsed, id) => ensureLayout(session, id),
        },
        executor,
    );
