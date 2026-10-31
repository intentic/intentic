import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentQuery } from "./claude-code-stream.js";
import type { MessageTally } from "../spend/message-tally.js";

type Result = Extract<SDKMessage, { type: "result" }>;

// Query.readMessages can repeat an assistant refusal in its result and then throw that result's text on exit.
// Keep the classified refusal: an unclassified copy would replace its recovery hold (including token renewal).
export class SdkFailures {
    private reported: string | undefined;

    report(message: string): void {
        this.reported = message.trim();
    }

    clear(): void {
        this.reported = undefined;
    }

    note(message: SDKMessage, parent: string | undefined): void {
        if (parent !== undefined) {
            return;
        }
        if (
            (message.type === "assistant" && message.error === undefined) ||
            (message.type === "stream_event" && message.event.type === "message_start") ||
            (message.type === "result" && message.subtype === "success" && message.is_error !== true)
        ) {
            this.clear();
        }
    }

    repeatsResult(message: Result): boolean {
        return this.reported !== undefined && message.subtype === "error_during_execution" && message.errors?.map((text) => text.trim()).filter(Boolean).join("; ") === this.reported;
    }

    repeats(error: Error): boolean {
        // allow(dependency-text): Claude Agent SDK's Query.readMessages wraps the result in this exact prefix; any unmatched error is rethrown.
        return this.reported !== undefined && error.message.trim() === `Claude Code returned an error result: ${this.reported}`;
    }
}

interface SdkFold {
    readonly failures: SdkFailures;
    readonly tally: Pick<MessageTally, "owedFrames">;
    readonly onMessage: (message: SDKMessage) => AsyncGenerator<AgentEvent, boolean>;
}

export async function* drainSdkMessages(messages: AsyncIterable<SDKMessage>, fold: SdkFold, session: AgentQuery): AsyncGenerator<AgentEvent> {
    try {
        for await (const message of messages) {
            const ended = yield* fold.onMessage(message);
            if (ended) {
                yield* fold.tally.owedFrames();
                // A terminal retry leaves the CLI sleeping. Interrupt before sdkTurns closes it to avoid the SDK's
                // stdin-close grace while the chat still shows a loader under the refusal.
                // allow(silent-catch): a CLI that cannot take the interrupt is still ended by the close, only later.
                await session.interrupt?.().catch(() => undefined);
                return;
            }
        }
    } catch (error) {
        if (!(error instanceof Error) || !fold.failures.repeats(error)) {
            throw error;
        }
    }
    // A stream with no result for its last requests still owes what they spent, including on a repeated SDK failure.
    yield* fold.tally.owedFrames();
}
