import type { SDKInformationalMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentNoticeLevel } from "@intentic/sandbox-contract";
import { isSafeguardFlagText } from "../providers/failure-sentences.js";

// The Claude Code loop's informational lines (`system`/`informational`: hook feedback, non-error status, a plugin's
// words) onto the runtime-neutral agent UI lane (sandbox-contract events/agent-ui.ts):
// - `info` is dropped: the CLI shows it in transcript mode only, so a chat that drew every one would read as a log.
// - `notice` and `suggestion` are an info notice, `warning` a warning notice.
// - A line naming a tool use is that call's progress, which the CLI replaces in place: a status entry keyed by the call,
//   cleared when its result arrives, rather than a row per step.
// - The safeguard's "stopped the response above" line is the refusal fork's (refusal-fork.ts), framed elsewhere.
// - The same words twice in one turn are said once.
// The hook lifecycle messages (`hook_started`/`hook_progress`/`hook_response`) never arrive: the loop is not asked for
// them (`includeHookEvents`), and a card per hook run would bury the turn.

const LEVELS: Readonly<Record<SDKInformationalMessage["level"], AgentNoticeLevel | undefined>> = {
    info: undefined,
    notice: "info",
    suggestion: "info",
    warning: "warning",
};

const progressKey = (toolUseId: string): string => `progress:${toolUseId}`;

// One turn's informational lines: what it already said, and which calls have a progress entry standing.
export class InformationalLines {
    private readonly said = new Set<string>();
    private readonly progressing = new Set<string>();

    // The frames one line becomes: none, a notice, or a call's progress entry.
    frames(message: Pick<SDKInformationalMessage, "content" | "level" | "tool_use_id">): AgentEvent[] {
        const level = LEVELS[message.level];
        const text = message.content.trim();
        if (level === undefined || text === "" || isSafeguardFlagText(text)) {
            return [];
        }
        if (message.tool_use_id !== undefined) {
            this.progressing.add(message.tool_use_id);
            return [{ kind: "agent_status", key: progressKey(message.tool_use_id), text }];
        }
        if (this.said.has(text)) {
            return [];
        }
        this.said.add(text);
        return [{ kind: "agent_notice", level, text }];
    }

    // The call's result arrived: its progress entry, if it had one, goes.
    settled(toolUseId: string): AgentEvent[] {
        return this.progressing.delete(toolUseId) ? [{ kind: "agent_status", key: progressKey(toolUseId), text: null }] : [];
    }
}
