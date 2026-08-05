/* THE NAMES OF THE SESSIONS ONE TURN OPENS.
 *
 * A turn that runs Bash gets a tmux session; a turn that browses gets a Chromium the daemon watches over CDP.
 * Both are named off the SDK session id by the same derivation, and both are listed together by
 * GET /system/terminals — so the name is wire vocabulary, not an implementation detail of either half.
 *
 * It lives in the contract because three parties derive it and none of them may guess: the daemon NAMES the
 * session, the web app OPENS it, and an extension that wants to point the user at a turn's live browser has only
 * the fleet roster's `sessionId` to work from. A second copy of this string math anywhere is a drift waiting to
 * happen — the copy would keep resolving to a plausible name that nothing has ever listed.
 *
 * Reached as `@intentic/sandbox-contract/session-names`, NOT through the barrel — the same shape tunnel-ids has,
 * and for the same reason: this module has no dependencies, while the barrel pulls the whole contract (and
 * @intentic/extension-api behind it). One subpath keeps a daemon unit test that only wants a session name from
 * having to resolve the entire wire surface.
 */

export const WEB_SESSION_PREFIX = "web-";
export const AGENT_SESSION_PREFIX = "agent-";
export const JOB_SESSION_PREFIX = "job-";
export const BROWSER_SESSION_PREFIX = "browser-";

/* Eight characters of the SDK session UUID, sanitized to the session-name charset. Eight is what groups a whole
 * turn's work — including its subagents' — under one name, and it clears the name guard
 * (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`) without further escaping. Undefined when the id sanitizes to empty, which
 * is never a valid session name. */
export const sessionSuffix = (sessionId: string): string | undefined => {
    const id = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
    return id === "" ? undefined : id;
};

// The tmux session one SDK session's Bash commands run in — the same derivation the Bash hook routes commands
// through, so an emitted `terminal` frame and the live session can't drift.
export const agentSessionName = (sessionId: string): string | undefined => {
    const suffix = sessionSuffix(sessionId);
    return suffix === undefined ? undefined : `${AGENT_SESSION_PREFIX}${suffix}`;
};

// The browser session one SDK session drives. Shares the suffix with agentSessionName on purpose: a
// conversation's shell and its browser read as the pair they are.
export const browserSessionName = (sessionId: string): string | undefined => {
    const suffix = sessionSuffix(sessionId);
    return suffix === undefined ? undefined : `${BROWSER_SESSION_PREFIX}${suffix}`;
};
