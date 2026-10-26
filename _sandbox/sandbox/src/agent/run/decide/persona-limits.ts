import { personaDisallowedTools, type TurnPersona } from "../../../personas/personas.js";
import type { DecidedRefusal } from "./turn-decision.js";
import type { TurnRuntime } from "./turn-premise.js";

/* A PERSONA'S LIMITS, REFUSED WHERE A RUNTIME CANNOT HOLD THEM.

   What a persona withholds (a tool, a folder outside its own, the sandbox's own config) binds every runtime that checks
   each call before it runs (AgentCapabilities.toolAllowlist): the Claude Code loop's hooks, Codex's and Pi's gate,
   Cursor's hooks, OpenCode's session rules (runtimes/daemon-tools/policy-gate.ts personaRefusal and its callers). A
   runtime that runs some calls without asking anyone cannot keep them, so a turn wearing such a persona is turned away
   before anything spawns, as a turn carrying a tool list is: running it would hand the persona the runtime's whole
   toolbox. 2026-10-25: before this, every runtime but Claude Code ran a read-only or fenced persona unrestricted. */

// The limits a persona puts on a turn, in words its owner would recognise; empty when it puts none a gate must hold.
const limitsOf = (persona: TurnPersona): string[] => {
    const tools = personaDisallowedTools(persona, []).filter((entry) => !entry.startsWith("Skill("));
    return [
        ...(tools.length === 0 ? [] : [`no ${tools.join(", ")}`]),
        ...(persona.fence === undefined ? [] : [`only ${persona.fence.length === 0 ? "no folder" : persona.fence.join(", ")}`]),
        ...(persona.powers.sandbox ? [] : ["no change to the sandbox's own configuration"]),
    ];
};

/** The refusal for a persona whose limits this runtime cannot keep, or undefined. */
export const personaLimitsRefusal = (persona: TurnPersona, runtime: TurnRuntime): DecidedRefusal | undefined => {
    if (runtime.capabilities.toolAllowlist) {
        return undefined;
    }
    const limits = limitsOf(persona);
    if (limits.length === 0) {
        return undefined;
    }
    // A built-in wears no limits of its own, so on one the limits are the access its principals hold (capPersona).
    const name = persona.persona?.label ?? persona.persona?.id ?? (persona.builtIn === undefined ? "this persona" : "the access this conversation runs under");
    const said = { provider: runtime.provider, harness: runtime.harness, persona: persona.persona?.id, limits: limits.length };
    return {
        ok: false,
        code: "tools-unenforced",
        message:
            `${name} limits this turn (${limits.join("; ")}), and ${runtime.provider} on this runtime cannot hold a turn to those limits, so it was not sent. ` +
            "Run it on a model whose runtime checks every call (Claude Code, Codex, OpenCode, Cursor or Pi), or wear a persona without these limits.",
        warnings: [{ fields: said, message: "persona: the turn's persona has limits its runtime cannot keep, refused before sending" }],
        spawn: false,
    };
};
