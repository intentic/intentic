import { errorMessage } from "@intentic/base/errors";
import { UnlinkedCheckoutError } from "../worktrees/checkout-link.js";

// The longest a broken land's words run on the card's record; git's own message can carry a whole command line.
const FAILURE_MAX_CHARS = 1_000;

// A land that threw rather than refused, as the card keeps it (AgentSummary.landFailure): its words, and `unlinked` when
// the checkout lost its link to the workspace, the one kind the board says in its own words.
export const landFailureOf = (cause: unknown): { readonly reason: string; readonly code?: string } => {
    const said = errorMessage(cause);
    const reason = said.length > FAILURE_MAX_CHARS ? `${said.slice(0, FAILURE_MAX_CHARS - 1)}…` : said;
    const code = cause instanceof UnlinkedCheckoutError ? "unlinked" : runnerFailureCode(said);
    return code === undefined ? { reason } : { reason, code };
};

// Stable categories let the editor localize a runner failure without showing an internal process name; a wording none
// of these match lands with no code, and the editor shows its own reason.
const runnerFailureCode = (said: string): string | undefined => {
    // allow(dependency-text): Node's and Bun's spawn error when a command line passes ARG_MAX.
    if (/E2BIG|argument list too long/iu.test(said)) {
        return "too_many_paths";
    }
    // allow(dependency-text): Node's maxBuffer error, by its message or its code spelled into it.
    if (/maxBuffer|ERR_CHILD_PROCESS_STDIO_MAXBUFFER/iu.test(said)) {
        return "output_limit";
    }
    // allow(dependency-text): our own git runner's sentence when its forker dies (@intentic/base/git).
    return /the forker exited/iu.test(said) ? "forker_exited" : undefined;
};
