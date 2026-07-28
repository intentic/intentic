/* What gets appended to Claude Code's preset system prompt for one turn — the SDK's `systemPrompt.append`.
 *
 * It APPENDS and never replaces. The preset is what makes this agent good at coding (a bare SDK turn ships an
 * empty system prompt), and the guidance blocks the runner appends beside it are what the chat's own widgets
 * are driven by: the question card, the plan approval, the checklist panel. A replaced prompt is a chat whose
 * cards silently stop appearing — which reaches the user as a broken app, not as a changed agent.
 *
 * ORDER IS THE WHOLE DESIGN. Every piece here is stable across a session, so the cached system+tools prefix
 * survives the conversation (the point of stableSystemPrompt). They are laid out most-stable first, so the
 * one a user actually edits sits at the very end and an edit can only ever invalidate the tail. */

// The concise-response steer (terseOutput): standing instructions that cut the model's OWN output tokens.
// Kept short so it barely costs tokens itself each turn.
const TERSE_NOTE =
    "Response style: be concise — don't restate the request, re-quote files you just read, or echo tool output the user can already see. Lead with the answer or the action; expand only where detail changes a decision.";

export interface SystemAppendParts {
    // The cross-provider delegation how-to, when Codex/Grok are reachable. Absent when neither is, and absent
    // HERE when stableSystemPrompt moved it into the user message instead.
    readonly note?: string;
    // The per-sandbox terseOutput toggle.
    readonly terseOutput: boolean;
    // The owner's own standing instructions (SandboxSettings.systemAppend); "" when they've written none.
    readonly customInstructions: string;
    // Whether this turn is answering someone OUTSIDE the sandbox — a web-chat visitor, a Discord mention, a
    // webhook (AgentTurn.origin). Such a turn is withheld the owner's instructions: those say how the agent
    // should talk to the OWNER, and "be blunt, skip the pleasantries, answer in Polish" reaching a stranger is
    // a leak, not a preference. An external wake is steered by its automation's own prompt instead.
    readonly external: boolean;
}

// undefined (not "") when nothing is appended: the runner spreads this into the SDK options, and an empty
// string would put a trailing separator on the preset prompt for no reason.
export const systemAppendOf = ({ note, terseOutput, customInstructions, external }: SystemAppendParts): string | undefined =>
    [
        ...(note !== undefined ? [note] : []),
        ...(terseOutput ? [TERSE_NOTE] : []),
        ...(customInstructions !== "" && !external ? [customInstructions] : []),
    ].join("\n\n") || undefined;
