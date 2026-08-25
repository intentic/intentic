/* AN ABORT THAT ALREADY HAPPENED STILL HAS TO REACH ITS HANDLER.
 *
 * `signal.addEventListener("abort", …)` on a signal that is ALREADY aborted never calls back. The event fired
 * before anything was listening and DOM events are not replayed, so the registration silently does nothing and
 * the work the handler existed to end runs to completion instead.
 *
 * The window is not theoretical, and it is not small. Every cancel/kill/interrupt in this daemon is registered
 * AFTER the thing it cancels exists, which means after an await: OpenCode's server boot plus its five-second
 * connect handshake before a session id exists to abort, the Codex binary lookup before the app-server is
 * spawned, a permission card a person answers before a JS run is dispatched. A Stop clicked anywhere in there
 * arrives as a signal that aborted before anyone was listening, and the turn goes on spending.
 *
 * rules/rule-command.ts found this the hard way and guards by hand; so do agent.ts, agent.routes.ts,
 * agent-requests.ts, subagents.ts and system.routes.ts, each in its own shape. This is that guard, once, so the
 * next registration cannot forget it: cancelled before the resource existed is still cancelled.
 *
 * The handler runs SYNCHRONOUSLY on an already-aborted signal rather than on a microtask. Deliberate: callers
 * register at the point where the resource is live, and deferring would hand the very next line a window to
 * hand out work under a signal it already knows is dead.
 *
 * Returns the un-register, for a caller whose handler outlives neither the turn nor the signal (a per-phase
 * listener on a per-turn signal is a leak the phase has to clean up itself). Calling it is always safe: it is a
 * no-op when the handler already ran or when there was no signal at all. */
export const whenAborted = (signal: AbortSignal | undefined, handler: () => void): (() => void) => {
    if (signal === undefined) {
        return (): void => {};
    }
    if (signal.aborted) {
        handler();
        return (): void => {};
    }
    signal.addEventListener("abort", handler, { once: true });
    return (): void => signal.removeEventListener("abort", handler);
};
