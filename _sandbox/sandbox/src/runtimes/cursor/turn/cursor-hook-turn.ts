import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentRequest, CursorCredential } from "../../../agent/providers/agent-request.js";
import { opt } from "../../../opt.js";
import type { TurnShield } from "../../../privacy/privacy-shield.js";
import type { CursorGateTurn } from "../cursor-hooks.js";
import { cursorHookShield } from "../cursor-shield.js";
import type { CursorOwner } from "./cursor-approvals.js";
import { cursorSecrets } from "./cursor-secrets.js";
import type { CursorSkills } from "./cursor-skills.js";
import { cursorTerminalOf } from "./cursor-terminal.js";

// What the hook service holds for one live turn (cursor-hooks.ts).
export const hookTurn = (input: {
    readonly agentId: string;
    readonly request: AgentRequest<CursorCredential>;
    readonly shellEnv: Record<string, string>;
    readonly systemAppend: string | undefined;
    readonly gate: CursorGateTurn["gate"];
    readonly push: (event: AgentEvent) => void;
    readonly shield: TurnShield | undefined;
    readonly list: readonly string[] | undefined;
    readonly owner: CursorOwner | undefined;
    readonly skills: CursorSkills | undefined;
}): CursorGateTurn => {
    const { request, shellEnv, skills } = input;
    return {
        conversationId: input.agentId,
        ...opt("cliEnv", Object.keys(shellEnv).length > 0 ? shellEnv : undefined),
        ...opt("systemAppend", input.systemAppend),
        gate: input.gate,
        push: input.push,
        ...opt("shield", input.shield === undefined ? undefined : cursorHookShield(input.shield)),
        ...opt("allowedTools", input.list),
        ...opt("secrets", request.tools.secrets === undefined ? undefined : cursorSecrets(request.tools.secrets)),
        // The shell in the terminal panel; the session is named from Cursor's agent id, as the conversation's is.
        ...opt("terminal", cursorTerminalOf(input.agentId, { envKeys: Object.keys(shellEnv), isolation: request.spec.isolation, owner: request.spec.conversationId })),
        ...opt("owner", input.owner),
        ...opt("deniedSkills", skills === undefined || skills.denied.length === 0 ? undefined : skills.denied),
        deniedTools: request.policy.disallowedTools,
        scope: request.policy.personaScope,
    };
};
