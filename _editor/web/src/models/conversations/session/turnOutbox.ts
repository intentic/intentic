import { createBackoff } from "@intentic/base/async";
import type { MessageReceipt } from "@intentic/sandbox-contract/schemas/agent";
import { shallowRef } from "vue";
import type { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import type { ProcedureInput } from "../../../client/sandbox/sandboxRpc";
import type { SentMessage } from "../../../client/sandbox/streams/turnStream";
import { uuid } from "../../../lib/uuid";
import type { ChatAttachment } from "../transcript/transcript";
import type { OutboxEntry } from "./sendOutbox";
import type { TranscriptView } from "./transcriptView";

// One conversation's words that did not reach the sandbox (sendOutbox.ts says why they wait rather than come back): drawn
// as waiting bubbles, sent again in the order written under the ids they first went out with, until the sandbox answers.
// What an answer then means for the turn (followed, handed back, left to the daemon's row) is the turn client's.

// What the outbox needs from the turn client it sends through.
export interface OutboxHost {
    readonly transcript: Pick<TranscriptView, "holdUnsent" | "unsentBubble" | "sentUnsent" | "dropLocal" | "persist" | "messages">;
    // One request to the daemon, tried again briefly under the same id; throws when no answer came at all.
    readonly post: (body: ProcedureInput<`agent.run`>) => Promise<MessageReceipt | SandboxHttpError>;
    // What the sandbox's answer means for these words, their waiting bubble (if still drawn) now an ordinary sent one.
    readonly answered: (entry: OutboxEntry, receipt: MessageReceipt | SandboxHttpError, bubble: number | undefined) => void;
    // Words handed back to the composer, under the id they went out with.
    readonly giveBack: (sent: SentMessage, messageId: string) => void;
}

// What waits for words the sandbox never answered for: the request as built, and what the person wrote.
export const unsentOf = (body: ProcedureInput<`agent.run`>, sent: SentMessage): OutboxEntry => ({
    messageId: body.messageId ?? uuid(),
    text: sent.text,
    attachments: sent.attachments,
    body,
    sentAt: Date.now(),
});

// The paths a waiting bubble draws its files from, only where it has any.
const attachmentRows = (attachments: readonly ChatAttachment[]): { attachments?: string[] } =>
    attachments.length === 0 ? {} : { attachments: attachments.map((file) => file.path) };

export class TurnOutbox {
    // Oldest first. Saved and restored with the tab's sandbox by useChat-sessions, which also asks for a flush whenever
    // the sandbox is back.
    readonly entries = shallowRef<readonly OutboxEntry[]>([]);
    // The flush under way, which a second ask joins rather than racing it for the same words.
    private flushing: Promise<void> | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    // How long the next unasked try waits: soon after a failure, then backing off, so a long outage costs a request every
    // half minute rather than a steady drip; a reconnect asks at once whatever the ladder says.
    private readonly ladder = createBackoff({ floorMs: 2_000, capMs: 30_000 });

    constructor(private readonly host: OutboxHost) {}

    /** Words that wait to go out: drawn as waiting (over the bubble a send drew, if it drew one), kept in the order written, and tried again soon. */
    keep(entry: OutboxEntry, bubble: number | undefined): void {
        const { transcript } = this.host;
        transcript.holdUnsent({ text: entry.text, messageId: entry.messageId, sentAt: entry.sentAt, ...attachmentRows(entry.attachments) }, bubble);
        if (!this.entries.value.some((waiting) => waiting.messageId === entry.messageId)) {
            this.entries.value = [...this.entries.value, entry];
        }
        transcript.persist();
        this.schedule();
    }

    /**
     * Words saved waiting from before this page loaded: drawn as waiting again, and sent once the sandbox is reachable. A
     * waiting bubble the mirror kept for words no longer waiting (sent after the mirror was written) goes: nothing holds
     * them to send.
     */
    adopt(entries: readonly OutboxEntry[]): void {
        const waiting = new Set(entries.map((entry) => entry.messageId));
        for (const message of this.host.transcript.messages.value) {
            if (message.unsent === true && (message.messageId === undefined || !waiting.has(message.messageId))) {
                this.host.transcript.dropLocal(message.id);
            }
        }
        for (const entry of entries) {
            this.keep(entry, undefined);
        }
    }

    /**
     * Sends whatever waits, oldest first, until one finds no answer (then the rest wait with it, tried again on the ladder
     * or when the sandbox is back) or nothing waits. A second ask while one runs joins it.
     */
    flush(): Promise<void> {
        if (this.flushing !== undefined) {
            return this.flushing;
        }
        if (this.entries.value.length === 0) {
            return Promise.resolve();
        }
        clearTimeout(this.timer);
        const flushing = (async (): Promise<void> => {
            for (let next = this.entries.value[0]; next !== undefined; next = this.entries.value[0]) {
                // In order: one that finds no answer holds every later one behind it.
                if (!(await this.resend(next))) {
                    this.schedule();
                    return;
                }
            }
            this.ladder.reset();
        })();
        this.flushing = flushing;
        void flushing.finally(() => {
            if (this.flushing === flushing) {
                this.flushing = undefined;
            }
        });
        return flushing;
    }

    /** Stops sending words that wait, and puts them back in the composer; they went nowhere, as far as this window knows. */
    cancel(messageId: string): void {
        const entry = this.entries.value.find((waiting) => waiting.messageId === messageId);
        if (entry === undefined) {
            return;
        }
        this.entries.value = this.entries.value.filter((waiting) => waiting !== entry);
        const bubble = this.host.transcript.unsentBubble(messageId);
        if (bubble !== undefined) {
            this.host.transcript.dropLocal(bubble.id);
        }
        // Under the id they waited with: sent again unchanged, a sandbox that took them after all answers the resend.
        this.host.giveBack({ text: entry.text, attachments: entry.attachments }, messageId);
        this.host.transcript.persist();
        if (this.entries.value.length === 0) {
            clearTimeout(this.timer);
        }
    }

    private schedule(): void {
        clearTimeout(this.timer);
        if (this.entries.value.length > 0) {
            this.timer = setTimeout(() => void this.flush(), this.ladder.next());
        }
    }

    // One waiting message sent again. False when the sandbox still did not answer; otherwise it is out of the outbox,
    // whatever the answer, which the turn client acts on.
    private async resend(entry: OutboxEntry): Promise<boolean> {
        let receipt: MessageReceipt | SandboxHttpError;
        try {
            receipt = await this.host.post(entry.body);
        } catch {
            // allow(silent-catch): no answer is this send's only failure, and the false is it: the words keep waiting.
            return false;
        }
        this.entries.value = this.entries.value.filter((waiting) => waiting.messageId !== entry.messageId);
        const bubble = this.host.transcript.unsentBubble(entry.messageId)?.id;
        if (bubble !== undefined) {
            this.host.transcript.sentUnsent(bubble);
        }
        this.host.answered(entry, receipt, bubble);
        return true;
    }
}
