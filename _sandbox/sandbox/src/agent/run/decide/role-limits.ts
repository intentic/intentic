import { roleDisallowedTools, type TurnRole } from "../../../roles/roles.js";
import type { DecidedRefusal } from "./turn-decision.js";
import type { TurnRuntime } from "./turn-premise.js";

/* A ROLE'S LIMITS, REFUSED WHERE A RUNTIME CANNOT HOLD THEM.

   What a role withholds (a tool, a folder outside its own, the sandbox's own config) binds every runtime that checks
   each call before it runs (AgentCapabilities.toolAllowlist): the Claude Code loop's hooks, Codex's and Pi's gate,
   Cursor's hooks, OpenCode's session rules (runtimes/daemon-tools/policy-gate.ts roleRefusal and its callers). A
   runtime that runs some calls without asking anyone cannot keep them, so a turn wearing such a role is turned away
   before anything spawns, as a turn carrying a tool list is: running it would hand the role the runtime's whole
   toolbox. 2026-10-25: before this, every runtime but Claude Code ran a read-only or fenced role unrestricted. */

// The limits a role puts on a turn, in words its owner would recognise; empty when it puts none a gate must hold.
const limitsOf = (role: TurnRole): string[] => {
    const tools = roleDisallowedTools(role, []).filter((entry) => !entry.startsWith("Skill("));
    return [
        ...(tools.length === 0 ? [] : [`no ${tools.join(", ")}`]),
        ...(role.fence === undefined ? [] : [`only ${role.fence.length === 0 ? "no folder" : role.fence.join(", ")}`]),
        ...(role.powers.sandbox ? [] : ["no change to the sandbox's own configuration"]),
    ];
};

/** The refusal for a role whose limits this runtime cannot keep, or undefined. */
export const roleLimitsRefusal = (role: TurnRole, runtime: TurnRuntime): DecidedRefusal | undefined => {
    if (runtime.capabilities.toolAllowlist) {
        return undefined;
    }
    const limits = limitsOf(role);
    if (limits.length === 0) {
        return undefined;
    }
    // A built-in wears no limits of its own, so on one the limits are the access its principals hold (capRole).
    const name = role.role?.label ?? role.role?.id ?? (role.builtIn === undefined ? "this role" : "the access this conversation runs under");
    const said = { provider: runtime.provider, harness: runtime.harness, role: role.role?.id, limits: limits.length };
    return {
        ok: false,
        code: "tools-unenforced",
        message:
            `${name} limits this turn (${limits.join("; ")}), and ${runtime.provider} on this runtime cannot hold a turn to those limits, so it was not sent. ` +
            "Run it on a model whose runtime checks every call (Claude Code, Codex, OpenCode, Cursor or Pi), or wear a role without these limits.",
        warnings: [{ fields: said, message: "role: the turn's role has limits its runtime cannot keep, refused before sending" }],
        spawn: false,
    };
};
