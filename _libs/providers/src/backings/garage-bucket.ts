import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { containerId } from "../core/backing-ssh.js";
import { parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import type { SshSession } from "../core/ssh.js";
import { type SshExecutor, sshExecutor } from "../core/ssh.js";

const BIN = "/garage";

const bucketSchema = sshSchema.extend({
    // The id of the Garage instance container to docker-exec the CLI in (stamped intentic.id=<instance>).
    instance: z.string(),
    // The instance's host-internal S3 endpoint, surfaced to the app as S3_ENDPOINT.
    endpoint: z.string(),
    // The per-app bucket + the access-key's friendly name (both the resolver-sanitized app slug).
    bucket: z.string(),
    keyName: z.string(),
});
type BucketInputs = z.infer<typeof bucketSchema>;
const parse = (inputs: ResolvedInputs): BucketInputs => parseInputs(bucketSchema, inputs, "garage-bucket");

// Run a garage CLI subcommand in the instance container; throws on a non-zero exit (with stderr).
const garage = async (session: SshSession, cid: string, args: string): Promise<string> => {
    const result = await session.exec(`docker exec ${cid} ${BIN} ${args}`);
    if (result.code !== 0) {
        throw new Error(`garage ${args.split(" ")[0]} failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
};

// The access key id + secret of the named key, read back from `garage key info --show-secret` (Garage owns
// them — it generates the pair on `key create`; the binding never sets them). Returns "" for a field not found.
const readKey = async (session: SshSession, cid: string, keyName: string): Promise<{ accessKey: string; secretKey: string }> => {
    const info = (await session.exec(`docker exec ${cid} ${BIN} key info --show-secret ${keyName}`)).stdout;
    const field = (label: string): string => info.match(new RegExp(`${label}:\\s*(\\S+)`))?.[1] ?? "";
    return { accessKey: field("Key ID"), secretKey: field("Secret key") };
};

const outputsFor = (parsed: BucketInputs, key: { accessKey: string; secretKey: string }): Record<string, unknown> => ({
    endpoint: parsed.endpoint,
    accessKey: key.accessKey,
    secretKey: key.secretKey,
    bucket: parsed.bucket,
});

// A per-app Garage bucket + access key (the binding for an app that uses an object-storage capability). read
// reports it present once the bucket exists (so the noop re-derives the credentials from `key info`); apply
// create-or-updates the bucket + key idempotently and grants the key read+write on the bucket; delete drops
// both. Garage generates + persists the key pair, so the access key/secret are stable across applies.
export const createGarageBucketProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`garage-bucket "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            const cid = await containerId(session, parsed.instance);
            if (cid === "") {
                return undefined;
            }
            const info = await session.exec(`docker exec ${cid} ${BIN} bucket info ${parsed.bucket}`);
            if (info.code !== 0) {
                return undefined;
            }
            return { outputs: outputsFor(parsed, await readKey(session, cid, parsed.keyName)) };
        } finally {
            await session.dispose();
        }
    },
    // The bucket/key names are stable and Garage persists the generated key pair, so a present bucket is a noop.
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            const cid = await containerId(session, parsed.instance);
            if (cid === "") {
                throw new Error(`garage-bucket "${ctx.id}": instance "${parsed.instance}" is not running`);
            }
            // bucket create + key create error if the resource already exists, so tolerate that; the grant is
            // idempotent. Then read the (Garage-generated) key pair back for the outputs.
            await session.exec(`docker exec ${cid} ${BIN} bucket create ${parsed.bucket} 2>/dev/null || true`);
            await session.exec(`docker exec ${cid} ${BIN} key create ${parsed.keyName} 2>/dev/null || true`);
            await garage(session, cid, `bucket allow --read --write ${parsed.bucket} --key ${parsed.keyName}`);
            return outputsFor(parsed, await readKey(session, cid, parsed.keyName));
        } finally {
            await session.dispose();
        }
    },
    delete: async (inputs, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            const cid = await containerId(session, parsed.instance);
            if (cid === "") {
                ctx.log(`garage-bucket "${ctx.id}": instance "${parsed.instance}" already gone; nothing to drop`);
                return;
            }
            await session.exec(`docker exec ${cid} ${BIN} bucket delete --yes ${parsed.bucket} 2>/dev/null || true`);
            await session.exec(`docker exec ${cid} ${BIN} key delete --yes ${parsed.keyName} 2>/dev/null || true`);
        } finally {
            await session.dispose();
        }
    },
});
