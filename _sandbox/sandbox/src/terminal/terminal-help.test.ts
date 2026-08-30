import { expect, test } from "vitest";
import { createRequest } from "../agent/agent-requests.js";
import { INTERNAL_SERVERS, outsideSourceOf } from "../guard/outside-results.js";
import { clearTerminalHelp, raiseTerminalHelp, settleTerminalHelpFor, terminalHelpFor } from "./terminal-help.js";

/* THE HANDOVER'S STATE, without a tmux server: everything the terminals list and the panel's banner render
 * from (raise, read, clear, and the session-died-under-it guarantee) is assertable here, exactly as the
 * browser's half is (browser/browser-help.test.ts). What needs a live pane is the tool's own precondition (is
 * anything actually waiting in there), which belongs with the tmux seam rather than in this file.
 *
 * Session names are per-test so the module's one map cannot carry state between them. */

test("an ask lands on the session and reads back for the banner", () => {
    raiseTerminalHelp("agent-he1p0001", { requestId: "r1", message: "npm wants the one-time password", requestedAt: 1 });
    expect(terminalHelpFor("agent-he1p0001")).toEqual({ requestId: "r1", message: "npm wants the one-time password", requestedAt: 1 });
    // Only the session it was raised on: the list hangs it on ONE row.
    expect(terminalHelpFor("agent-somebody-else")).toBeUndefined();

    // Settled by id, so a stale settle can never take down a newer ask on the same session.
    clearTerminalHelp("r-not-this-one");
    expect(terminalHelpFor("agent-he1p0001")).toEqual(expect.any(Object));
    clearTerminalHelp("r1");
    expect(terminalHelpFor("agent-he1p0001")).toBeUndefined();
});

/* The terminal dying under a parked ask must settle it: the parked tool call waits on a PERSON, not on tmux,
 * so nothing else would ever release it: the turn would sit parked on a banner the kill just took down. The
 * settle reads as "not helped", which is the honest account of a terminal that went away first. */
test("killing the session settles its open ask as not-helped", async () => {
    const { id, wait } = createRequest("terminal_help", { kind: "terminal_help", requestId: "", helped: false, note: "aborted" });
    raiseTerminalHelp("agent-he1p0002", { requestId: id, message: "touch the security key", requestedAt: 2 });

    const settled = wait(new AbortController().signal);
    settleTerminalHelpFor("agent-he1p0002");
    const { reply } = await settled;
    expect(reply.helped).toBe(false);
    expect(reply.note).toContain("closed");
    // And the banner state came down with it.
    expect(terminalHelpFor("agent-he1p0002")).toBeUndefined();
});

/* THE HAND-BACK CARRIES A COMMAND'S BYTES, and the split that makes that safe is easy to undo by accident.
 *
 * The server is INTERNAL: it is the daemon talking about the turn, and wrapping the whole result would tell
 * the model its own platform is a stranger (guard/outside-results.ts states the rule). What that buys is the
 * obligation the tool then owes: the PANE TEXT it returns is some command's output, so it wraps that one field
 * itself. Deleting either half is a silent change: an unwrapped screen is a way to launder exactly what the
 * Bash seam wraps (fetch, let it stall, hand over, read the answer back clean), and a wrapped whole result is
 * the platform calling itself outside. This pins the first half; the tool's own comment pins the second.
 */
test("the terminal server is internal: its own results are not wrapped as a stranger's", () => {
    expect(INTERNAL_SERVERS.has("terminal")).toBe(true);
    expect(outsideSourceOf("mcp__terminal__request_help", {})).toBeUndefined();
});

// Killing a session nobody is parked on is the ordinary case (every × on every other tab): it must not throw
// and must not reach for a waiter that was never there.
test("killing a session with no ask on it does nothing", () => {
    expect(() => settleTerminalHelpFor("agent-he1p0003")).not.toThrow();
    expect(terminalHelpFor("agent-he1p0003")).toBeUndefined();
});

/* The turn ending under the ask is the OTHER way it settles, and it settles through the abort signal rather
 * than through this module, but the banner still has to come down, which is the tool's `clearTerminalHelp`
 * after its wait. Asserted here because a settle that leaves the flag up strands a banner over a turn that is
 * already gone, on a session that will happily accept a NEW ask later. */
test("a turn aborting under the ask settles the waiter, and clearing takes the banner down", async () => {
    const abort = new AbortController();
    const { id, wait } = createRequest("terminal_help", {
        kind: "terminal_help",
        requestId: "",
        helped: false,
        note: "the turn ended before anyone could help",
    });
    raiseTerminalHelp("agent-he1p0004", { requestId: id, message: "confirm the prompt", requestedAt: 3 });

    const settled = wait(abort.signal);
    abort.abort();
    const { reply } = await settled;
    expect(reply.helped).toBe(false);
    expect(reply.note).toContain("the turn ended");

    clearTerminalHelp(id);
    expect(terminalHelpFor("agent-he1p0004")).toBeUndefined();
});
