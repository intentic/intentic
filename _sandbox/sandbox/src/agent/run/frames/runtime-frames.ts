import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../../../composition.js";
import { withTextBoundaries } from "./text-boundaries.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { withRuntimeSubagents } from "../../subagents/runtime-subagents.js";

// A runtime's frames as the turn reads them (stream-agent.ts). The Claude Code loop files its own subagents from the
// SDK's task stream (agent.ts); every other runtime reports its own as frames, filed on their way through here, so a
// subagent Codex, Cursor or OpenCode starts is on the roster the same way. A turn with no conversation has nowhere to
// file one. Every runtime's prose blocks are closed here too, whether or not its loop said where each one ends.
export const runtimeFrames = (services: Pick<Services, "conversations">, input: RoutedTurn, frames: AsyncIterable<AgentEvent>): AsyncIterable<AgentEvent> =>
    withTextBoundaries(
        input.conversationId === undefined || capabilitiesOf(input.agent, input.harness).runtime === "claude-code"
            ? frames
            : withRuntimeSubagents(frames, { conversationId: input.conversationId, conversations: services.conversations, subagentsDir: undefined }),
    );
