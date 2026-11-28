import type { IdentityReach } from "@intentic/extension-api";
import { HybridSigSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { z } from "zod";
import { CheckpointSchema } from "../log/checkpoint.js";
import { fromBase64, toBase64, verifyConsistency } from "../log/merkle.js";
import { verifyCheckpoint } from "../log/verify.js";
import { DOOR_PREFIX, type PeerNet } from "./net.js";
import type { PeerStore } from "./peer-store.js";

/* BEING A WITNESS (off unless the owner turns `witnessMode` on): a reader of some log asks this sandbox to cosign that
   log's checkpoint. The witness believes nothing the reader sends but the checkpoint itself: it resolves the log's
   address and verifies the checkpoint against the identity it finds there, and when it has cosigned that log before, it
   reads a consistency proof from the log's own door and cosigns only a checkpoint that extends the last one it cosigned.
   So a log that shows two readers two different histories cannot get both cosigned by the same witness, and a reader
   who gathers cosignatures from witnesses it trusts knows it was shown the history they saw. */

export const WITNESS_PURPOSE = `witness.cosign`;
// How many logs one witness keeps state for, so a flood of addresses costs bounded disk.
const WITNESS_LOGS_MAX = 5000;

export const WitnessRequestSchema = z.object({ address: z.string().min(1).max(260), checkpoint: CheckpointSchema });

const CosignatureSchema = z.object({ origin: z.string(), size: z.number().int().min(0), root: z.string(), cosignedAt: z.iso.datetime() });
export const WitnessAnswerSchema = z.object({ cosignature: CosignatureSchema, sig: HybridSigSchema, fingerprint: z.string() });
export type WitnessAnswer = z.infer<typeof WitnessAnswerSchema>;

export interface WitnessDeps {
    readonly net: PeerNet;
    readonly peers: PeerStore;
    readonly identity: IdentityReach;
    readonly enabled: () => Promise<boolean>;
    readonly now: () => number;
}

type Outcome = { readonly ok: true; readonly answer: WitnessAnswer } | { readonly ok: false; readonly status: 400 | 404 | 409 | 502; readonly error: string };
const refuse = (status: 400 | 404 | 409 | 502, error: string): Outcome => ({ ok: false, status, error });

// Whether the checkpoint extends what this witness cosigned for the log before, reading the proof from the log itself.
const extendsLast = async (deps: WitnessDeps, host: string, last: { readonly size: number; readonly root: string }, size: number, root: Uint8Array): Promise<string | undefined> => {
    if (size < last.size) {
        return `this log is smaller than the ${last.size} entries this witness cosigned before`;
    }
    const lastRoot = fromBase64(last.root);
    if (lastRoot === undefined) {
        return `this witness's own record of the log does not read`;
    }
    if (size === last.size) {
        return Buffer.from(lastRoot).equals(Buffer.from(root)) ? undefined : `this log shows another root at a size this witness cosigned`;
    }
    const answer = await deps.net.get(host, `${DOOR_PREFIX}/log/proof/consistency?from=${last.size}&to=${size}`, AbortSignal.timeout(15_000));
    const proof = z.object({ proof: z.array(z.string()) }).safeParse(answer.body);
    const hashes = proof.success ? proof.data.proof.map((hash) => fromBase64(hash)) : [];
    const readable = proof.success && hashes.every((hash) => hash !== undefined);
    return readable && verifyConsistency(last.size, size, lastRoot, root, hashes.filter((hash) => hash !== undefined)) ? undefined : `this log does not extend the history this witness cosigned`;
};

export const cosignFor = async (deps: WitnessDeps, request: z.infer<typeof WitnessRequestSchema>): Promise<Outcome> => {
    if (!(await deps.enabled())) {
        return refuse(404, `this sandbox is not a witness`);
    }
    const resolved = await deps.net.resolve(request.address);
    if (!resolved.ok) {
        return refuse(502, resolved.message);
    }
    const head = verifyCheckpoint(resolved.document, request.checkpoint);
    if (!head.ok) {
        return refuse(400, head.reason);
    }
    const { origin, size, root } = head.value;
    const last = deps.peers.witnessState(origin);
    if (last === undefined && deps.peers.witnessCount() >= WITNESS_LOGS_MAX) {
        return refuse(409, `this witness follows as many logs as it keeps`);
    }
    const problem = last === undefined ? undefined : await extendsLast(deps, resolved.host, last, size, root);
    if (problem !== undefined) {
        return refuse(409, problem);
    }
    const cosignature = { origin, size, root: toBase64(root), cosignedAt: new Date(deps.now()).toISOString() };
    const signed = await deps.identity.sign(WITNESS_PURPOSE, cosignature);
    deps.peers.saveWitnessState(origin, size, cosignature.root, request.checkpoint, deps.now());
    return { ok: true, answer: { cosignature, sig: signed.sig, fingerprint: signed.fingerprint } };
};
