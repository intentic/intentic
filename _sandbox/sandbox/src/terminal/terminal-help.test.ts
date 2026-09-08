import { expect, test } from "vitest";
import { createRequest } from "../agent/tools/agent-requests.js";
import { INTERNAL_SERVERS, outsideSourceOf } from "../guard/outside-results.js";
import { clearTerminalHelp, raiseTerminalHelp, settleTerminalHelpFor, terminalHelpFor } from "./terminal-help.js";

// The handover's state without a tmux server: raise, read, clear, and the session-died guarantee. What needs a live
// pane belongs in the tmux integration test. Session names are per-test since the module holds one map.

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

// A parked ask waits on a person, not tmux, so killing the terminal must settle it itself; it settles as not-helped,
// the honest account.
test("killing the session settles its open ask as not-helped", async () => {
    const { id, wait } = createRequest("terminal_help", { kind: "terminal_help", requestId: "", helped: false, note: "aborted" });
    raiseTerminalHelp("agent-he1p0002", { requestId: id, message: "touch the security key", requestedAt: 2 });

    const settled = wait(new AbortController().signal);
    settleTerminalHelpFor("agent-he1p0002");
    const { reply } = await settled;
    expect(reply.helped).toBe(false);
    expect(reply.note).toContain("terminal");
    expect(reply.note).not.toContain("turn ended");
    // And the banner state came down with it.
    expect(terminalHelpFor("agent-he1p0002")).toBeUndefined();
});

// The server is internal (unwrapped), but the pane text it returns is a command's output, so the tool wraps that field
// itself; dropping either half is a silent way to launder untrusted output.
test("the terminal server is internal: its own results are not wrapped as a stranger's", () => {
    expect(INTERNAL_SERVERS.has("terminal")).toBe(true);
    expect(outsideSourceOf("mcp__terminal__request_help", {})).toBeUndefined();
});

// The ordinary case (every × on every other tab): must not throw or reach for a waiter that was never there.
test("killing a session with no ask on it does nothing", () => {
    expect(() => settleTerminalHelpFor("agent-he1p0003")).not.toThrow();
    expect(terminalHelpFor("agent-he1p0003")).toBeUndefined();
});

// The other settle path: an aborted turn settles through the abort signal, but the banner only comes down via
// clearTerminalHelp; otherwise it strands over a turn that's already gone.
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
    expect(reply.note).toContain("turn ended");
    expect(reply.note).not.toContain("terminal was closed");

    clearTerminalHelp(id);
    expect(terminalHelpFor("agent-he1p0004")).toBeUndefined();
});
