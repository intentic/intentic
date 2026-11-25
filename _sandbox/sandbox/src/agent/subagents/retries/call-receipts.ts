import type { Logger } from "pino";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { CHILDREN } from "../child-records.js";
import type { ChildActionResult, ChildSpawnResult, ChildSupervisor } from "../children.js";
import { type MutationKey, mutationReceipts, type Receipted, toJson, usableRequestId } from "./mutation-receipts.js";

// The supervisor's moves a retry could repeat to harm: a second child, a message said twice, a cancel (safe to repeat,
// receipted so its retry answers as the first did). Each is answered from its receipt (mutation-receipts.ts) when its
// caller names the call; the tools that only read, and the rest, run as they are.

export const RECEIPTED_TOOLS: ReadonlySet<string> = new Set(["spawn", "send", "cancel"]);

const REPLAYED = "This call was taken before the link dropped; this is what it did then, and nothing was done again.";

// What a restart left of a spawn taken before it: the child of this parent it started, asking what it asked, at or after
// it was taken; else nothing came of it.
const recoveredSpawn = (actors: Pick<ConversationActors, "holdings">, parent: string, prompt: string, at: number): ChildSpawnResult => {
    const started = actors
        .holdings(CHILDREN)
        .entries()
        .find(([, kid]) => kid.parent === parent && kid.spec.prompt === prompt && kid.startedAt >= at);
    if (started === undefined) {
        return {
            ok: false,
            message: "The sandbox restarted while this spawn ran, and no child of yours was started from it, so nothing came of it. Spawn again if the task still needs one.",
        };
    }
    return { ok: true, id: started[0], note: "The sandbox restarted while this spawn ran; this is the child it had already started." };
};

const SEND_CUT =
    "The sandbox restarted while this send ran, so whether the message reached the child is not known. Read the child with wait before sending it again.";

const answered = <T extends ChildActionResult | ChildSpawnResult>(outcome: Receipted<T>): T | { readonly ok: false; readonly message: string } => {
    switch (outcome.kind) {
        case "mismatch":
            return { ok: false, message: outcome.message };
        case "ran":
        case "recovered":
            return outcome.value;
        case "replayed":
            return outcome.value.ok ? { ...outcome.value, note: [REPLAYED, outcome.value.note].filter((part) => part !== undefined).join(" ") } : outcome.value;
    }
};

export interface ReceiptDeps {
    readonly conversations: Pick<ConversationActors, "holdings">;
    readonly historyRoot: string;
    readonly logger: Pick<Logger, "warn">;
}

/**
 * The supervisor with its spawn, send and cancel answered once per call: `requestId` is the caller's id for this one call,
 * kept across its retries. Without a usable id, the supervisor as it was.
 */
export const receiptedSupervisor = (deps: ReceiptDeps, conversationId: string, requestId: string | undefined, supervisor: ChildSupervisor): ChildSupervisor => {
    if (!usableRequestId(requestId)) {
        return supervisor;
    }
    const receipts = mutationReceipts(deps.historyRoot, deps.logger);
    const key = (tool: string): MutationKey => ({ conversationId, tool, requestId });
    return {
        ...supervisor,
        spawn: async (spec) =>
            answered(
                await receipts.run(
                    key("spawn"),
                    toJson(spec),
                    () => supervisor.spawn(spec),
                    async (at) => recoveredSpawn(deps.conversations, conversationId, spec.prompt, at),
                ),
            ),
        send: async (childId, message, rehome) =>
            answered(
                await receipts.run(
                    key("send"),
                    toJson({ childId, message, rehome }),
                    () => supervisor.send(childId, message, rehome),
                    async (): Promise<ChildActionResult> => ({ ok: false, message: SEND_CUT }),
                ),
            ),
        // A cancel cut off by a restart is run again: stopping what is already stopped changes nothing.
        cancel: async (childId) =>
            answered(await receipts.run(key("cancel"), toJson({ childId }), () => supervisor.cancel(childId), () => supervisor.cancel(childId))),
    };
};
