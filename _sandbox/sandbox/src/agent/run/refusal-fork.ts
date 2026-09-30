import type { SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isSafeguardFlagText } from "../providers/failure-sentences.js";

// Where a turn the provider's safety classifier stopped can be resumed from, so a retry carries none of what was stopped.
//
// The CLI streams a stopped response like any other (its blocks arrive with `stop_reason` still null), says so only
// afterwards, and keeps it in the session: its own one retry on the same model follows it with a nudge, and a plain
// resume would send all of it back to the model. So every main-thread entry is remembered with the API message it came
// from, the responses the classifier stopped are marked as the CLI names them, and the fork point is the last entry
// before the run of stopped responses at the end. Checked against the real CLI on 2026-09-30: the SDK's `uuid` is the
// session transcript's own chain id, and `resumeSessionAt` there sends only what came before it.

interface Entry {
    readonly uuid: string;
    // The API message an assistant entry belongs to (one per content block, so several share it); absent on a user entry.
    readonly response?: string;
}

// What classifying the flag reads: the classifier's category and the entry a retry resumes the session at.
export interface RefusalPoint {
    readonly category?: string;
    readonly resumeAt?: string;
}

// The CLI's synthetic "API Error: … safeguards flagged …" assistant message that ends a flagged turn: structured on a CLI
// that reports `stop_reason: "refusal"`, the prose otherwise.
export const isSafeguardRefusal = (message: SDKAssistantMessage): boolean => {
    if (message.error === undefined) {
        return false;
    }
    if (message.message.stop_reason === "refusal") {
        return true;
    }
    return message.message.content.some((block) => block.type === "text" && isSafeguardFlagText(block.text));
};

export class RefusalFork {
    private readonly entries: Entry[] = [];
    // API message ids of the responses the classifier stopped.
    private readonly stopped = new Set<string>();
    // The response the last assistant entry came from: what the CLI's refusal notices, which name none, are about.
    private lastResponse: string | undefined;
    private category: string | undefined;
    // The person's message the stopped request answered, as the CLI names it: the fork point when nothing in this turn
    // came before the stopped response.
    private refusedPrompt: string | undefined;

    // Takes every SDK message in stream order; only the main thread's are the session a retry resumes.
    note(message: SDKMessage): void {
        if ((message.type === "assistant" || message.type === "user") && (message.parent_tool_use_id ?? null) !== null) {
            return;
        }
        if (message.type === "assistant") {
            this.noteAssistant(message);
        } else if (message.type === "user" && message.uuid !== undefined) {
            this.entries.push({ uuid: message.uuid });
        } else if (message.type === "system" && message.subtype === "model_refusal_no_fallback") {
            this.markStopped(message.api_refusal_category ?? undefined);
            this.refusedPrompt = message.refused_user_message_uuid ?? this.refusedPrompt;
        } else if (message.type === "system" && message.subtype === "informational" && isSafeguardFlagText(message.content)) {
            // "… safeguards stopped the response above · continuing once": the CLI's own retry on the same model.
            this.markStopped(undefined);
        }
    }

    // The category named, and the last entry before the stopped responses that end the turn; no fork point when none was
    // marked (a CLI that said it only in prose), which leaves the retry a plain resume.
    point(): RefusalPoint {
        const first = this.firstStopped();
        const resumeAt = first === undefined ? undefined : first === 0 ? this.refusedPrompt : this.entries[first - 1]?.uuid;
        const named: RefusalPoint = this.category === undefined ? {} : { category: this.category };
        return resumeAt === undefined ? named : { ...named, resumeAt };
    }

    private noteAssistant(message: SDKAssistantMessage): void {
        if (message.error !== undefined) {
            // The synthetic error closing the flag, not a response: marks the one before it, and carries no entry.
            if (isSafeguardRefusal(message)) {
                this.markStopped(message.message.stop_details?.category ?? undefined);
            }
            return;
        }
        this.lastResponse = message.message.id;
        this.entries.push({ uuid: message.uuid, response: message.message.id });
    }

    private markStopped(category: string | undefined): void {
        if (this.lastResponse !== undefined) {
            this.stopped.add(this.lastResponse);
        }
        this.category = category ?? this.category;
    }

    // Where the closing run of stopped responses begins: user entries between them (a tool call the CLI declined to run,
    // its retry's nudge) belong to the run; any response the classifier let through ends it.
    private firstStopped(): number | undefined {
        let first: number | undefined;
        for (let index = this.entries.length - 1; index >= 0; index--) {
            const response = this.entries[index]?.response;
            if (response === undefined) {
                continue;
            }
            if (!this.stopped.has(response)) {
                break;
            }
            first = index;
        }
        return first;
    }
}
