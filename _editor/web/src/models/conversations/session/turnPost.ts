import { retry } from "@intentic/base/async";
import type { MessageReceipt } from "@intentic/sandbox-contract/schemas/agent";
import { orRefusal, SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { type ProcedureInput, sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import type { Conversation } from "./conversation";

// A message sent again under the same id while no answer comes back: the daemon answers a resend with what it did the
// first time, so trying again can never deliver the words twice. Bounds a network blip, not an outage.
const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = 500;

// The one door a conversation's words go through to the sandbox (TurnClient). A fresh session's origin
// (Conversation.pendingFreshOf) rides the first send the daemon takes, sent now or booked, and that one alone: a refusal
// keeps it for the retry, an answer spends it.
export const postTurn = async (
    host: Pick<Conversation, "box" | "pendingFreshOf">,
    body: ProcedureInput<`agent.run`>,
    signal: AbortSignal,
): Promise<MessageReceipt | SandboxHttpError> => {
    const freshOf = host.pendingFreshOf.value;
    const receipt = await retry(() => orRefusal(sandboxRpc.agent.run({ ...body, freshOf }, { signal, context: { at: host.box.value } })), {
        attempts: SEND_ATTEMPTS,
        delayMs: (attempt) => SEND_RETRY_MS * attempt,
        signal,
    });
    if (!(receipt instanceof SandboxHttpError)) {
        host.pendingFreshOf.value = undefined;
    }
    return receipt;
};
