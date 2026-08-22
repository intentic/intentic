/* THE ONE HEADER THAT JOINS A BROWSER CALL TO THE DAEMON LINE THAT SERVED IT.
 *
 * Both halves of a slow interaction were already measured and could not be put together. The browser times
 * `rpc.request`, what the user actually waited for; the daemon times `http.request`, what it served; and on a
 * sandbox answering several calls a second the only way to pair them was by timestamp and hope. So "the panel
 * stuttered" stayed unattributable even with both numbers in hand, which is the gap the daemon's own perf module
 * says it exists to close and could only close on its own side of the wire.
 *
 * Here rather than as a literal on each side, because a header name that disagrees across the wire fails
 * SILENTLY: the browser sends a field nobody reads and the daemon logs nothing, which looks exactly like a quiet
 * system. Both sides import this.
 *
 * The NAME only. The browser mints the value with the app's own `composables/uuid.ts`, which already solves the
 * one hard part (`crypto.randomUUID` is a secure-context api and a self-hosted instance on a LAN address does
 * not have it), and the daemon only ever reads what it is given. A generator here would be a second answer to a
 * question that already has a better one. The value is a correlation token and never a security boundary: the
 * daemon records it and decides nothing on it, so a caller repeating one confuses a log and nothing else. */
export const REQUEST_ID_HEADER = "x-intentic-request-id";

/* WHEN A BROWSER MAY SEND IT, and this is not the additive change it looks like.
 *
 * A custom request header is the one wire addition that is NOT backward compatible, because the browser does not
 * get to decide it: a header outside the CORS safelist forces a preflight, and a daemon whose `allowHeaders`
 * predates this name answers a preflight that omits it. The browser then fails the whole request rather than
 * dropping the header. Sent unconditionally, this turns "one field the daemon never logs" into EVERY typed call
 * to that daemon failing at the transport, `system.events` included, so the stream never opens, the connection
 * never reaches `online`, and the app settles on "Busy, catching up" forever against a sandbox that is up and
 * healthy and answering `/health` in a millisecond.
 *
 * That state is not exotic. A browser newer than its daemon is the NORMAL case and a supported one, both in
 * production (every user's sandbox runs whatever image they last chose to pull, and COMPATIBILITY.md's second
 * promise is that no update is ever forced) and in development (the web app runs from the working tree, the
 * daemon is baked into the last `pnpm build:sandbox`). See the web app's useDaemonRoutes.ts, which exists to say
 * exactly this.
 *
 * So the header ships gated on POSITIVE evidence, and this names the evidence: `logs.report` is the route that
 * landed in the same commit as the `allowHeaders` entry, so a daemon advertising it on its hello frame is a
 * daemon whose CORS accepts the header. Note the polarity is the opposite of `supportsRoute`'s: there, no
 * evidence means assume-supported, because hiding a working feature is the greater harm; here, no evidence must
 * mean DO NOT SEND, because sending costs the entire connection and the header buys a log field. */
export const REQUEST_ID_EVIDENCE_ROUTE = "logs.report";
