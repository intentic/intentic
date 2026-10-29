import { retry, sleep } from "@intentic/base/async";
import type { MessageReceipt } from "@intentic/sandbox-contract/schemas/agent";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import { lastEdgeVerdict } from "../../../client/sandbox/edgeVerdict";
import { orRefusal, SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { type ProcedureInput, sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import type { Conversation } from "./conversation";

// A message sent again under the same id while no answer comes back: the daemon answers a resend with what it did the
// first time, so trying again can never deliver the words twice. Bounds a network blip, not an outage.
const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = 500;

// The waits before each resend of a send refused on the way to the daemon (`unheard`), doubling, 15 s in all: room for
// the edge to see a sandbox's tunnel back after an edge restart or a dropped carrier, and for netd to see its daemon back
// after a restart. Past that the refusal is shown and the words handed back, as before.
const RESEND_WAITS_MS = [1_000, 2_000, 4_000, 8_000] as const;

// What the path to the daemon answers when the daemon never saw the request.
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503]);

// A refusal written on the way to the daemon, never by it, which a resend under the same id can get past: the edge's 502
// when it holds no tunnel for the sandbox or lost the request on one (`no-tunnel`, `dropped`), and netd's 502 when the
// daemon did not answer and 503 while the daemon restarts. Both write a plain-text sentence, so the refusal carries none
// of the words a daemon refusal always does (an oRPC handler's `message`, a route's `error`). Not the edge's
// `unknown-sandbox`, which no wait changes, and not a daemon's own 502: that is its answer. The verdict is the edge's
// last word on this sandbox (edgeVerdict.ts), noted as this very answer passed through.
const unheard = (answer: MessageReceipt | SandboxHttpError, sandboxId: string | undefined): answer is SandboxHttpError =>
    answer instanceof SandboxHttpError &&
    GATEWAY_STATUSES.has(answer.status) &&
    answer.said.message === undefined &&
    answer.said.error === undefined &&
    lastEdgeVerdict(sandboxId) !== `unknown-sandbox`;

// The one door a conversation's words go through to the sandbox (TurnClient). A fresh session's origin
// (Conversation.pendingFreshOf) and a branch start (Conversation.pendingFromBranch) ride the first send the daemon takes,
// sent now or booked, and that one alone: a refusal keeps them for the retry, an answer spends them.
export const postTurn = async (
    host: Pick<Conversation, "box" | "pendingFreshOf" | "pendingFromBranch">,
    body: ProcedureInput<`agent.run`>,
    signal: AbortSignal,
): Promise<MessageReceipt | SandboxHttpError> => {
    const freshOf = host.pendingFreshOf.value;
    const fromBranch = host.pendingFromBranch.value;
    const send = () =>
        retry(() => orRefusal(sandboxRpc.agent.run({ ...body, freshOf, fromBranch }, { signal, context: { at: host.box.value } })), {
            attempts: SEND_ATTEMPTS,
            delayMs: (attempt) => SEND_RETRY_MS * attempt,
            signal,
        });
    let receipt = await send();
    for (const waitMs of RESEND_WAITS_MS) {
        // A conversation in the active sandbox calls with no `at`; the edge's verdict is noted under the sandbox's own id.
        if (!unheard(receipt, host.box.value ?? activeSandboxId.value)) {
            break;
        }
        // resends are sequential by definition
        await sleep(waitMs, { signal });
        // A Stop during the wait ends the tries as retry's own wait does, with the signal's reason.
        signal.throwIfAborted();
        receipt = await send();
    }
    if (!(receipt instanceof SandboxHttpError)) {
        host.pendingFreshOf.value = undefined;
        host.pendingFromBranch.value = undefined;
    }
    return receipt;
};
