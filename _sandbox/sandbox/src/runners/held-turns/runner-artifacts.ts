import { open } from "node:fs/promises";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { ORPCError } from "@orpc/client";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import {
    ARTIFACT_CHUNK_BYTES,
    ARTIFACT_FILE_MAX_BYTES,
    ARTIFACTS_DIR,
    artifactDigest,
    artifactPart,
    fileDigest,
    keepArtifactCopy,
} from "../../workspace/files/stored/stored-artifacts.js";
import type { RunnerHub } from "../runner-peer.js";

/* FILES A RUNNER'S TURN MADE, BROUGHT HOME IN PIECES. A file past one socket frame (a take, a trace, a PDF of scans)
   travels as pieces of ARTIFACT_CHUNK_BYTES, written next to where it is filed and filed once whole, by the rule every
   copy here follows: its own name when free or already holding these bytes, else the next numbered one
   (stored-artifacts.ts). And as a runner's turn says `done`, everything it left in the runner's artifacts folder (a
   PDF, a video, an evidence file an agent was told to put there, a file its reply links) is swept home first: neither the
   relay nor the branch's push carries that folder, so those files used to stay on the runner (2026-11-23). */

const ASK_MS = 60_000;

// Past this much in one turn's sweep, the rest stays on the runner and the turn says so.
const SWEEP_TURN_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface ArtifactsHomeContext {
    readonly hub: Pick<RunnerHub, "client">;
    readonly logger: Pick<Logger, "warn">;
    readonly runnerId: string;
    readonly workspaceRoot: string;
}

export const askOptions = () => ({ signal: AbortSignal.timeout(ASK_MS) });

// One piece of a file as a door answers it: no bytes when the parent's `have` matched, and no size from a runner too old
// to cut a file in pieces, whose answer is then the whole file.
export interface Piece {
    readonly bytesBase64?: string | undefined;
    readonly size?: number | undefined;
    // The whole file's digest, with the first of several pieces.
    readonly sha256?: string | undefined;
}

export type Ask = (range: { readonly offset: number; readonly length: number; readonly have?: string }) => Promise<Piece>;

export type Fetched = { readonly kind: "filed"; readonly path: string } | { readonly kind: "too-large" } | { readonly kind: "failed" };

const FAILED: Fetched = { kind: "failed" };

// Writes `first` and then every further piece `ask` answers into `real`, until `size` bytes are there; false when a piece
// comes back empty, overruns the size, or says the file's size changed: the file moved under the copy.
const writePieces = async (real: string, first: Buffer, size: number, ask: Ask): Promise<boolean> => {
    const handle = await open(real, "wx");
    try {
        await handle.write(first);
        for (let offset = first.length; offset < size; ) {
            const answer = await ask({ offset, length: ARTIFACT_CHUNK_BYTES });
            const piece = Buffer.from(answer.bytesBase64 ?? "", "base64");
            if (piece.length === 0 || piece.length > size - offset || (answer.size !== undefined && answer.size !== size)) {
                return false;
            }
            await handle.write(piece, 0, piece.length, offset);
            offset += piece.length;
        }
        return true;
    } finally {
        await handle.close();
    }
};

// The rest of a file after its first piece, into a part beside where it is filed, then filed.
const fetchRest = async (context: ArtifactsHomeContext, filedAs: string, first: Buffer, size: number, sha256: string | undefined, ask: Ask): Promise<Fetched> => {
    const part = await artifactPart(context.workspaceRoot, filedAs);
    if (part === undefined) {
        return FAILED;
    }
    let whole = false;
    try {
        // Whole only as the runner hashed it: a file that grew or changed between pieces is not filed mixed.
        whole = (await writePieces(part.real, first, size, ask)) && (sha256 === undefined || (await fileDigest(part.real)) === sha256);
    } finally {
        if (!whole) {
            await part.discard();
        }
    }
    if (!whole) {
        // The file changed under the copy: what came is not the file the turn made.
        return FAILED;
    }
    const filed = await part.keep();
    return filed === undefined ? FAILED : { kind: "filed", path: filed };
};

/**
 * Brings one file home through `ask`, filed by keepArtifactCopy's rule at `filedAs` (a workspace path in the artifacts
 * folder): answers where it was filed, or why it was not. A file this workspace already holds at `filedAs` byte for byte
 * costs no bytes. A refusal for size answers `too-large`; any other failure throws, for the caller to log.
 */
export const fetchHome = async (context: ArtifactsHomeContext, filedAs: string, ask: Ask, max = ARTIFACT_FILE_MAX_BYTES): Promise<Fetched> => {
    const have = await artifactDigest(context.workspaceRoot, filedAs);
    let first: Piece;
    try {
        first = await ask({ offset: 0, length: ARTIFACT_CHUNK_BYTES, ...opt("have", have) });
    } catch (error) {
        if (error instanceof ORPCError && error.code === "PAYLOAD_TOO_LARGE") {
            return { kind: "too-large" };
        }
        throw error;
    }
    if (first.bytesBase64 === undefined) {
        return have === undefined ? FAILED : { kind: "filed", path: filedAs };
    }
    const bytes = Buffer.from(first.bytesBase64, "base64");
    if (first.size === undefined || bytes.length >= first.size) {
        const filed = await keepArtifactCopy(context.workspaceRoot, filedAs, bytes);
        return filed === undefined ? FAILED : { kind: "filed", path: filed };
    }
    return first.size > max ? { kind: "too-large" } : fetchRest(context, filedAs, bytes, first.size, first.sha256, ask);
};

// What a sweep's ask throws once the turn's bytes are spent: the file in hand stays on the runner.
class SweepSpent extends Error {}

const mib = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MiB`;

const skippedNotice = (skipped: readonly string[]): AgentEvent => ({
    kind: "agent_notice",
    level: "warning",
    text: `${skipped.length === 1 ? "A file" : `${skipped.length} files`} this turn left in the runner's artifacts folder ${skipped.length === 1 ? "was" : "were"} too large to bring here (over ${mib(ARTIFACT_FILE_MAX_BYTES)} each, or ${mib(SWEEP_TURN_MAX_BYTES)} in all), so ${skipped.length === 1 ? "it stays" : "they stay"} on the runner: ${skipped.join(", ")}`,
});

/**
 * Brings home everything the runner's artifacts folder holds that changed within the last `withinMs`: the frames to relay
 * before `done` (one notice when something stayed behind for its size, none otherwise). A runner too old to list its
 * artifacts, or out of reach, brings nothing and says nothing.
 */
export const sweepArtifactsHome = async (context: ArtifactsHomeContext, withinMs: number, maxBytes = SWEEP_TURN_MAX_BYTES): Promise<readonly AgentEvent[]> => {
    const client = context.hub.client(context.runnerId);
    if (client === undefined) {
        return [];
    }
    let listed;
    try {
        listed = await client.listArtifacts({ withinMs: Math.max(1, Math.ceil(withinMs)) }, askOptions());
    } catch (error) {
        if (!(error instanceof ORPCError && error.code === "NOT_FOUND")) {
            context.logger.warn({ err: error, runner: context.runnerId }, "runner dispatch: the runner's artifacts could not be listed");
        }
        return [];
    }
    const skipped: string[] = [];
    // Bytes that actually came, not what the listing said: a size it reports is the runner's word, not a bound.
    let total = 0;
    for (const file of listed.files) {
        if (!file.path.startsWith(ARTIFACTS_DIR)) {
            continue;
        }
        if (file.size > ARTIFACT_FILE_MAX_BYTES || total + file.size > maxBytes) {
            skipped.push(file.path);
            continue;
        }
        const live = context.hub.client(context.runnerId) ?? client;
        const counted: Ask = async (range) => {
            const piece = await live.readArtifact({ path: file.path, ...range }, askOptions());
            total += Math.floor(((piece.bytesBase64 ?? "").length * 3) / 4);
            if (total > maxBytes) {
                throw new SweepSpent();
            }
            return piece;
        };
        try {
            const fetched = await fetchHome(context, file.path, counted);
            if (fetched.kind === "too-large") {
                skipped.push(file.path);
            }
        } catch (error) {
            if (error instanceof SweepSpent) {
                skipped.push(file.path);
                continue;
            }
            context.logger.warn({ err: error, runner: context.runnerId, path: file.path }, "runner dispatch: a file the runner's turn left could not be brought home");
        }
    }
    return skipped.length === 0 ? [] : [skippedNotice(skipped)];
};
