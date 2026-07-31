import { SETUP_NOTICE_HEADER } from "../workspace/workspace-setup.js";
import { DELEGATION_NOTE_HEADER } from "./delegation.js";
import { TURN_CONTEXT_NOTE_HEADER } from "./turn-context.js";

// Turn preambles: notes the daemon prepends to a user message before it reaches the model — the delegation
// how-to (when stableSystemPrompt keeps it out of the system prompt), the dependency-readiness notice (which
// must ride the user message because it changes the moment an install finishes, while the system prefix stays
// byte-stable for the prompt cache), the workspace context retrieved for this very message (same reason), and
// the literal-slash note below. They are protocol, not something the
// user said — but the SDK transcript stores the combined prompt verbatim, so a reopened tab would redraw them
// as the user's own words: the "Dependencies are NOT installed" text stapled onto their message after every
// refresh or sandbox rebuild. Builder and stripper live together so restore recognizes exactly what a turn
// injected — including in transcripts written before this module existed, which used the same shape.

const SEPARATOR = "\n\n---\n\n";

/* The note a `/`-leading prompt earns when the name is no command this session has (agent-commands.ts owns
 * that call). Its job is positional before it is semantic: with anything ahead of it the user's text no longer
 * opens the message, so the CLI's slash parser never claims it and the words reach the model instead of being
 * answered with "Unknown command" and dropped. It says something true and useful while it is there — the model
 * would otherwise have to guess whether `/workspace` names a command, a route, or a path. */
export const LITERAL_SLASH_NOTE_HEADER = "## Reading the message below";

export const LITERAL_SLASH_NOTE =
    `${LITERAL_SLASH_NOTE_HEADER}\n\n` +
    "It opens with `/` but names no slash command available here — the leading token is the user's own words " +
    "(a route, a path, a filename). Read the whole message as ordinary prose.";

/* WHERE A CWD-ISOLATED RUNTIME'S TREE IS, told in words because there is no seam to enforce it.
 *
 * An isolated conversation on the Claude Code loop has its worktree bind-mounted over /work, so every absolute
 * path the agent inherited from a memory, an AGENTS.md or its own earlier turn already names its own space
 * (agents/isolation.ts) — and when the container can't build that namespace, the tool-input rewrite keeps the
 * same guarantee one layer up (agents/worktree-redirect.ts). Neither layer reaches the runtimes that declare
 * `isolation: "cwd"`: Codex drives an SDK with no spawn seam to enter, and an ACP agent talks to a pooled
 * connection that outlives the turn. They are cwd'd into their worktree and nothing else, so an absolute
 * /work path lands in the SHARED checkout — which is exactly how three agents once spent a morning writing
 * into main while their worktrees stayed empty.
 *
 * A note is second-best to a mechanism and says so in its own text; it is what these runtimes can be given
 * today. It names both trees, because "don't touch /work" without "your tree is HERE" just costs a retry. */
export const WORKTREE_NOTE_HEADER = "## Where this turn's files live";

export const worktreeNote = (worktree: string, root: string): string =>
    `${WORKTREE_NOTE_HEADER}\n\n` +
    `This conversation works on its own git branch, checked out at \`${worktree}\` — and this runtime reaches ` +
    `it by working directory alone, so \`${root}\` is still the SHARED checkout every other agent is editing. ` +
    `Use relative paths, or absolute paths under \`${worktree}\`. An absolute \`${root}/…\` path (from a memory, ` +
    `an AGENTS.md, or an earlier turn) writes outside your branch, where the work is neither reviewed nor landed.`;

export const withTurnPreamble = (notes: readonly string[], prompt: string): string =>
    notes.length === 0 ? prompt : `${notes.join("\n\n")}${SEPARATOR}${prompt}`;

// The restore-side inverse. Anchored, not fuzzy: only a message that STARTS with a known injected note is
// touched, and only up to the FIRST separator — a user who typed `---` themselves keeps their text intact.
export const stripTurnPreamble = (text: string): string => {
    const injected = [DELEGATION_NOTE_HEADER, SETUP_NOTICE_HEADER, TURN_CONTEXT_NOTE_HEADER, LITERAL_SLASH_NOTE_HEADER, WORKTREE_NOTE_HEADER];
    if (!injected.some((header) => text.startsWith(header))) {
        return text;
    }
    const separator = text.indexOf(SEPARATOR);
    return separator === -1 ? text : text.slice(separator + SEPARATOR.length);
};
