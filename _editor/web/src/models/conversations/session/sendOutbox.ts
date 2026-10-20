import { AgentRunSchema } from "@intentic/sandbox-contract/schemas/agent";
import { storedJson, storeJson } from "@intentic/ui/storage";
import { z } from "zod";
import { outboxKey } from "../../../app/storage/browserStorage";
import type { ProcedureInput } from "../../../client/sandbox/sandboxRpc";
import type { ChatAttachment } from "../transcript/transcript";

/* WORDS THAT DID NOT REACH THE SANDBOX WAIT HERE, NOT IN AN ERROR LINE. A send the sandbox never answered (a train, a lid
   shut mid-send, a tunnel restarting) used to come back to the composer with an error after three quick tries, for the
   person to notice and send again. It stays where it was sent instead, drawn as waiting (ChatMessage.unsent), and goes
   out again by itself, in order, when the sandbox is back: TurnClient.flushOutbox. Sending it again can never deliver it
   twice: it keeps the message id it first went out under, and the sandbox answers a known id with what it did the first
   time (turn-admission.ts `duplicate`), which also covers a first try that did arrive and only lost its answer.

   Kept in this browser's storage per sandbox, beside the tabs it belongs to, so a reload or an update of the app (which
   drops the transcript mirror whole) does not lose words the sandbox never had. */

export interface OutboxEntry {
    // The id the words went out under first, and go out under every time after.
    readonly messageId: string;
    // What the person sent, for the bubble that stands for it and for handing it back if the sandbox refuses it.
    readonly text: string;
    readonly attachments: readonly ChatAttachment[];
    // The request as it was first sent: what the person asked for then, routing and all.
    readonly body: ProcedureInput<`agent.run`>;
    // When it was first sent (ms), for the bubble's clock.
    readonly sentAt: number;
}

const EntrySchema = z.object({
    messageId: z.string().min(1),
    text: z.string(),
    attachments: z.array(z.object({ name: z.string(), path: z.string() })),
    // The request's own shape, so a body this build cannot send is dropped on reading rather than sent malformed.
    body: AgentRunSchema,
    sentAt: z.number(),
});
// Every conversation's waiting words in one sandbox, by conversation id.
const OutboxSchema = z.object({ conversations: z.record(z.string(), z.array(EntrySchema)) });

// The waiting words of one conversation, oldest first; none when nothing waits or storage is unavailable.
export const storedOutbox = (sandboxId: string, conversationId: string): readonly OutboxEntry[] =>
    storedJson(outboxKey(sandboxId), OutboxSchema)?.conversations[conversationId] ?? [];

// Writes one conversation's waiting words, dropping its entry once nothing waits.
export const storeOutbox = (sandboxId: string, conversationId: string, entries: readonly OutboxEntry[]): void => {
    const conversations = { ...storedJson(outboxKey(sandboxId), OutboxSchema)?.conversations };
    if (entries.length === 0) {
        delete conversations[conversationId];
    } else {
        conversations[conversationId] = entries.map((entry) => ({ ...entry, attachments: [...entry.attachments] }));
    }
    storeJson(outboxKey(sandboxId), { conversations });
};
