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
