import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import { sessionUpdateEvent as readUpdate, type TerminalExit } from "@intentic/acp-events/events";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { workspacePath } from "../../sessions/vocabulary/tool-calls.js";

// An ACP session/update as the daemon reads one: the shared reading (@intentic/acp-events `sessionUpdateEvent`, which a
// computer's turns read through too), with the paths an agent names put onto the workspace's route space the daemon's
// own way (`workspacePath`: the Claude state folders linked into the workspace are not an escape). `terminalExit` says
// how a terminal this daemon ran for the agent exited (acp-terminal.ts), for a call that embeds it and names no code.
export const sessionUpdateEvent = (update: SessionUpdate, cwd: string, terminalExit?: TerminalExit): AgentEvent | undefined =>
    readUpdate(update, cwd, terminalExit === undefined ? { pathOf: workspacePath } : { pathOf: workspacePath, terminalExit });
