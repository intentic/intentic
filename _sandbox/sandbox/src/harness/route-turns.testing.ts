import type { AttachFrame, sandboxContract, TranscriptRow, TurnFact } from "@intentic/sandbox-contract";
import { applyTranscriptPatch } from "@intentic/sandbox-contract/transcript-fold";
import type { ContractRouterClient } from "@orpc/contract";
import { expect } from "vitest";
import { collect } from "./route-client.testing.js";

/* The route harness's turn runner: a chat turn driven over the detached-run protocol exactly as the browser
 * drives it, and what the attach stream said, in the shapes a test asks about. Not part of the build (tsconfig
 * excludes `*.testing.ts`), type-checked with the tests (tsconfig.test.json). */

// What one turn said over the attach stream, in the shapes a test asks about.
export interface TurnOutcome {
    readonly head: Extract<AttachFrame, { kind: "attached" }>;
    readonly entries: Extract<AttachFrame, { kind: "patch" | "fact" }>[];
    // The facts the turn stated, in order: worktree, session, tier, error and the rest (TURN_FACT_KINDS).
    readonly facts: TurnFact[];
    // The run's rows once every patch has landed, which is what its record holds.
    readonly rows: TranscriptRow[];
}

// Drive a chat turn over the detached-run protocol exactly as the browser does: start (acked with the run
// id), attach, and keep what the stream said. Awaiting the attach to its `end` is also the settle barrier the
// old in-request stream gave these tests. Ids are minted per turn unless the test pins one (the run registry
// is keyed by conversationId across the whole test process).
let turnCounter = 0;
export const runAgentTurn = async (
    client: ContractRouterClient<typeof sandboxContract>,
    input: Record<string, unknown> & { prompt: string; conversationId?: string },
): Promise<TurnOutcome> => {
    const conversationId = input.conversationId ?? `turn-${(turnCounter += 1)}`;
    const { run } = await client.agent.run({ ...input, conversationId });
    const frames = await collect(await client.agent.attach({ conversationId }));
    const head = frames[0];
    if (head?.kind !== "attached" || head.run !== run) {
        throw new Error(`attach did not open on run ${run}: ${JSON.stringify(head)}`);
    }
    expect(frames.at(-1)).toEqual({ kind: "end" });
    const entries = frames.flatMap((frame) => (frame.kind === "patch" || frame.kind === "fact" ? [frame] : []));
    return { head, entries, facts: entries.flatMap((entry) => (entry.kind === "fact" ? [entry.fact] : [])), rows: attachedRows(frames) };
};

// The rows an attach stream leaves a reader holding: the head's, with every patch after it applied.
export const attachedRows = (frames: readonly AttachFrame[]): TranscriptRow[] =>
    frames.reduce<TranscriptRow[]>((rows, frame) => {
        if (frame.kind === "attached") {
            return frame.rows;
        }
        return frame.kind === "patch" ? applyTranscriptPatch(rows, frame.patch) : rows;
    }, []);
