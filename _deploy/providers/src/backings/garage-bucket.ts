import type { Provider } from "@intentic/engine";
import { z } from "zod";
import { bindingSchema, createInstanceBindingProvider } from "../core/instance-binding.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import { GARAGE_BIN, runGarage } from "./garage.js";

const bucketSchema = bindingSchema.extend({
    // The instance's host-internal S3 endpoint, surfaced to the app as S3_ENDPOINT.
    endpoint: z.string(),
    // The per-app bucket + the access-key's friendly name (both the resolver-sanitized app slug).
    bucket: z.string(),
    keyName: z.string(),
});
type BucketInputs = z.infer<typeof bucketSchema>;

// The access key id + secret of the named key, read back from `garage key info --show-secret` (Garage generates
// the pair on `key create`). Both are required: an empty one would reach the app as its S3 credential.
const readKey = async (session: SshSession, cid: string, keyName: string): Promise<{ accessKey: string; secretKey: string }> => {
    const info = await runGarage(session, cid, `key info --show-secret ${keyName}`);
    const field = (label: string): string => {
        const value = info.match(new RegExp(`${label}:\\s*(\\S+)`))?.[1];
        if (value === undefined) {
            throw new Error(`garage key info ${keyName}: no "${label}:" line in its output`);
        }
        return value;
    };
    return { accessKey: field("Key ID"), secretKey: field("Secret key") };
};

const outputsFor = (parsed: BucketInputs, key: { accessKey: string; secretKey: string }): Record<string, unknown> => ({
    endpoint: parsed.endpoint,
    accessKey: key.accessKey,
    secretKey: key.secretKey,
    bucket: parsed.bucket,
});

// A per-app Garage bucket + access key. Garage generates + persists the key pair, so the access key/secret are
// stable across applies.
export const createGarageBucketProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createInstanceBindingProvider(
        {
            kind: "garage-bucket",
            schema: bucketSchema,
            // The S3 endpoint comes from the instance, so during plan it can still be the PENDING placeholder.
            pendingRefs: ["endpoint"],
            // Present only with both halves: a bucket whose key is gone reads as absent, so create makes and grants it.
            present: async (session, cid, parsed) => {
                const bucket = await session.exec(`docker exec ${cid} ${GARAGE_BIN} bucket info ${parsed.bucket}`);
                const key = bucket.code === 0 ? await session.exec(`docker exec ${cid} ${GARAGE_BIN} key info ${parsed.keyName}`) : undefined;
                return key?.code === 0 ? outputsFor(parsed, await readKey(session, cid, parsed.keyName)) : undefined;
            },
            create: async (session, cid, parsed) => {
                // bucket create + key create error if the resource already exists, so tolerate that; the grant is
                // idempotent.
                await session.exec(`docker exec ${cid} ${GARAGE_BIN} bucket create ${parsed.bucket} 2>/dev/null || true`);
                await session.exec(`docker exec ${cid} ${GARAGE_BIN} key create ${parsed.keyName} 2>/dev/null || true`);
                await runGarage(session, cid, `bucket allow --read --write ${parsed.bucket} --key ${parsed.keyName}`);
                return outputsFor(parsed, await readKey(session, cid, parsed.keyName));
            },
            drop: async (session, cid, parsed) => {
                await session.exec(`docker exec ${cid} ${GARAGE_BIN} bucket delete --yes ${parsed.bucket} 2>/dev/null || true`);
                await session.exec(`docker exec ${cid} ${GARAGE_BIN} key delete --yes ${parsed.keyName} 2>/dev/null || true`);
            },
        },
        executor,
    );
