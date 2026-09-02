import type { Provider } from "@intentic/engine";
import { z } from "zod";
import { bindingSchema, createInstanceBindingProvider } from "../core/instance-binding.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

const BIN = "/garage";

const bucketSchema = bindingSchema.extend({
    // The instance's host-internal S3 endpoint, surfaced to the app as S3_ENDPOINT.
    endpoint: z.string(),
    // The per-app bucket + the access-key's friendly name (both the resolver-sanitized app slug).
    bucket: z.string(),
    keyName: z.string(),
});
type BucketInputs = z.infer<typeof bucketSchema>;

// Run a garage CLI subcommand in the instance container; throws on a non-zero exit (with stderr).
const garage = async (session: SshSession, cid: string, args: string): Promise<string> => {
    const result = await session.exec(`docker exec ${cid} ${BIN} ${args}`);
    if (result.code !== 0) {
        throw new Error(`garage ${args.split(" ")[0]} failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
};

// The access key id + secret of the named key, read back from `garage key info --show-secret` (Garage owns
// them, it generates the pair on `key create`; the binding never sets them). Returns "" for a field not found.
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
export const createGarageBucketProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createInstanceBindingProvider(
        {
            kind: "garage-bucket",
            schema: bucketSchema,
            // The S3 endpoint comes from the instance, so during plan it can still be the PENDING placeholder.
            pendingRefs: ["endpoint"],
            present: async (session, cid, parsed) => {
                const info = await session.exec(`docker exec ${cid} ${BIN} bucket info ${parsed.bucket}`);
                return info.code === 0 ? outputsFor(parsed, await readKey(session, cid, parsed.keyName)) : undefined;
            },
            create: async (session, cid, parsed) => {
                // bucket create + key create error if the resource already exists, so tolerate that; the grant is
                // idempotent. Then read the (Garage-generated) key pair back for the outputs.
                await session.exec(`docker exec ${cid} ${BIN} bucket create ${parsed.bucket} 2>/dev/null || true`);
                await session.exec(`docker exec ${cid} ${BIN} key create ${parsed.keyName} 2>/dev/null || true`);
                await garage(session, cid, `bucket allow --read --write ${parsed.bucket} --key ${parsed.keyName}`);
                return outputsFor(parsed, await readKey(session, cid, parsed.keyName));
            },
            drop: async (session, cid, parsed) => {
                await session.exec(`docker exec ${cid} ${BIN} bucket delete --yes ${parsed.bucket} 2>/dev/null || true`);
                await session.exec(`docker exec ${cid} ${BIN} key delete --yes ${parsed.keyName} 2>/dev/null || true`);
            },
        },
        executor,
    );
