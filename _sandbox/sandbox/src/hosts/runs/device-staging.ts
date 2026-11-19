import { randomBytes } from "node:crypto";
import type { ArtifactKind } from "@intentic/sandbox-contract/schemas/device-artifacts";
import type { HostClient } from "../host-peer.js";

// CARRYING BYTES INTO A COMPUTER'S STAGING (schemas/device-artifacts.ts), for `devices push` (device-artifacts.routes.ts)
// and a stack's deploy (../stacks/device-stacks.ts) alike: ask whether the machine already holds exactly these bytes, else send
// them a chunk per call and file them with one commit. The machine checks "Run programs this sandbox sends" on every
// op, so a refusal can arrive at any of them; whatever stops a send, the machine's half-written upload is thrown away.

// What the machine files the bytes as: the folder name, whether to unpack them, the file's own name, and the size and
// hash it checks what arrived against.
export interface StagedBundle {
    readonly name: string;
    readonly kind: ArtifactKind;
    readonly fileName: string;
    readonly size: number;
    readonly sha256: string;
}

// Per-call deadlines, for a caller with none of its own around the whole send. A chunk is 2 MiB, so one that takes long
// means the computer went quiet; a commit of a `tar` unpacks it there, which takes as long as the folder is big.
export interface StagingDeadlines {
    readonly chunkMs: number;
    readonly commitMs: number;
}

// How a send ended: where the machine filed the bundle, or what stopped it and how many bytes had gone by then.
export type StagingOutcome = { readonly path: string } | { readonly failure: Error; readonly sent: number };

type Stager = Pick<HostClient, "stageArtifact">;

const within = (ms: number | undefined): { signal: AbortSignal } | undefined => (ms === undefined ? undefined : { signal: AbortSignal.timeout(ms) });

// Where the machine already holds this exact bundle, or undefined when it has to be sent. Throws what the machine said.
export const alreadyStaged = async (client: Stager, bundle: StagedBundle, deadlineMs?: number): Promise<string | undefined> => {
    const had = await client.stageArtifact({ op: "have", name: bundle.name, sha256: bundle.sha256, kind: bundle.kind, fileName: bundle.fileName }, within(deadlineMs));
    return had.path;
};

// Sends `chunks` in order (each at most the contract's chunk size) and files them. Never throws: a failure is an outcome,
// since each caller words it for its own reader.
export const stageBundle = async (client: Stager, bundle: StagedBundle, chunks: AsyncIterable<Buffer>, deadlines?: StagingDeadlines): Promise<StagingOutcome> => {
    const upload = randomBytes(16).toString("hex");
    let sent = 0;
    try {
        for await (const chunk of chunks) {
            if (sent + chunk.byteLength > bundle.size) {
                throw new Error(`more bytes arrived than the ${bundle.size} the push announced`);
            }
            await client.stageArtifact({ op: "chunk", upload, offset: sent, data: chunk.toString("base64") }, within(deadlines?.chunkMs));
            sent += chunk.byteLength;
        }
        const { name, kind, fileName, size, sha256 } = bundle;
        const committed = await client.stageArtifact({ op: "commit", upload, name, kind, fileName, size, sha256 }, within(deadlines?.commitMs));
        if (committed.path === undefined) {
            throw new Error("the computer took the bytes but did not say where it put them");
        }
        return { path: committed.path };
    } catch (failure) {
        // allow(silent-catch): the abort only tidies the machine's half-written upload; the send already failed and says why
        await client.stageArtifact({ op: "abort", upload }, within(deadlines?.chunkMs)).catch(() => undefined);
        return { failure: failure instanceof Error ? failure : new Error(String(failure)), sent };
    }
};
