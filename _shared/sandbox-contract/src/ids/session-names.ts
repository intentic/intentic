// Names of the sessions one turn opens: a tmux session for Bash, a CDP-watched Chromium for browsing, both derived from
// the SDK session id and listed together by GET /system/terminals. Three parties derive this name (daemon, web app, an
// extension) and none may guess, so the derivation lives here, not copied.

export const WEB_SESSION_PREFIX = "web-";
export const AGENT_SESSION_PREFIX = "agent-";
export const JOB_SESSION_PREFIX = "job-";
export const BROWSER_SESSION_PREFIX = "browser-";

// Eight characters of the SDK session UUID, sanitized to the name-guard charset; groups a turn's work, including its
// subagents', under one name. Undefined when it sanitizes to empty.
export const sessionSuffix = (sessionId: string): string | undefined => {
    const id = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
    return id === "" ? undefined : id;
};

// The tmux session one SDK session's Bash commands run in, the same derivation the Bash hook routes commands through,
// so an emitted `terminal` frame and the live session can't drift.
export const agentSessionName = (sessionId: string): string | undefined => {
    const suffix = sessionSuffix(sessionId);
    return suffix === undefined ? undefined : `${AGENT_SESSION_PREFIX}${suffix}`;
};

// The browser session one SDK session drives. Shares the suffix with agentSessionName on purpose: a conversation's
// shell and its browser read as the pair they are.
export const browserSessionName = (sessionId: string): string | undefined => {
    const suffix = sessionSuffix(sessionId);
    return suffix === undefined ? undefined : `${BROWSER_SESSION_PREFIX}${suffix}`;
};
