import { HybridSigSchema, S2sFingerprintSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { z } from "zod";
import { fromBase64, type Hash, toBase64 } from "./merkle.js";

/* A LOG'S CHECKPOINT: the C2SP tlog-checkpoint note body (an origin line naming the log, the tree size in decimal, the
   root hash in standard base64, then extension lines), signed as the sandbox under `ext:intentic.network/log.checkpoint`.
   C2SP's own note signatures are Ed25519 lines under the body; this log's keys are the sandbox's hybrid Ed25519 +
   ML-DSA-65 pair, which no note verifier knows, so the signature rides beside the body as JSON instead. The body is the
   standard one, so a witness that speaks tlog-checkpoint reads the same three facts. */

export const CheckpointSchema = z.object({
    body: z.string().max(4096).describe(`The C2SP tlog-checkpoint body: origin, size, base64 root, extension lines, each ending in a newline.`),
    sig: HybridSigSchema,
    fingerprint: S2sFingerprintSchema,
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export interface CheckpointFacts {
    readonly origin: string;
    readonly size: number;
    readonly root: Hash;
    // When the sandbox signed it, as the extension line `published <ISO time>`.
    readonly publishedAt: string;
}

// The origin a sandbox's log answers to: its host and this protocol's name, which a checkpoint for another log never has.
export const originOf = (host: string): string => `${host}/intentic.network`;

export const checkpointBody = ({ origin, size, root, publishedAt }: CheckpointFacts): string => `${origin}\n${size}\n${toBase64(root)}\npublished ${publishedAt}\n`;

// The body's facts, or undefined for a body that is not a checkpoint of this shape.
export const parseCheckpointBody = (body: string): CheckpointFacts | undefined => {
    if (!body.endsWith(`\n`)) {
        return undefined;
    }
    const [origin, sizeLine, rootLine, ...extensions] = body.slice(0, -1).split(`\n`);
    const size = Number(sizeLine);
    const root = rootLine === undefined ? undefined : fromBase64(rootLine);
    const published = extensions.find((line) => line.startsWith(`published `))?.slice(`published `.length);
    if (origin === undefined || origin === `` || !/^(?:0|[1-9]\d*)$/u.test(sizeLine ?? ``) || !Number.isSafeInteger(size) || root?.length !== 32 || published === undefined) {
        return undefined;
    }
    return { origin, size, root, publishedAt: published };
};
