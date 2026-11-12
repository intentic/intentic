// HOW LONG A CALL TO THE OWNER'S OWN BROWSER IS WAITED ON, AT EACH HOP (2026-11-12). The longest call is wait_for, which
// an agent gives up to 540 s (nine minutes) to let a page finish generating an image or a video
// (_devices/webext/src/background/tools/page.ts MAX_WAIT_SECONDS). Two deadlines sit outside it, each past the one inside:
// 1. the hub's, on the call over the browser's socket: ten minutes. The wait ends by 540 s; a page that freezes in its
//    last round is given up on 20 s later (page-wait.ts: the round's 15 s grace, a 5 s probe), and one still loading
//    10 s more, so at least 30 s are left for the page read after it and the trip back;
// 2. the agent's MCP client, past the hub's, so it never cuts a call the hub is still waiting on. Left to the client's
//    default, Claude Code cut every browser call at 60 s, whatever the extension was still doing, as it once did every
//    device call (peers/device-call-deadline.ts).

/** The hub's ceiling on one call to a connected browser. */
export const WEBEXT_CALL_TIMEOUT_MS = 10 * 60_000;

/** What the agent's MCP client is told to wait on one browser call (the mount's `timeoutMs`): longer than the hub ever does. */
export const WEBEXT_CLIENT_TIMEOUT_MS = WEBEXT_CALL_TIMEOUT_MS + 60_000;
