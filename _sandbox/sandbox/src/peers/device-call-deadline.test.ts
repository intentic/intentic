import { DEVICE_ANSWER_MARGIN_MS, DEVICE_CALL_CEILING_MS, DEVICE_CLIENT_TIMEOUT_MS, deviceCallDeadline, QUICK_CALL_MS } from "./device-call-deadline.js";

// The three deadlines nest: the call's own on the device, the bridge's just past it, the agent's client past the
// bridge's longest. A device call cut by the client's 60 s default (48 of them to 2026-10-26) is what this prevents.

const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name, arguments: args } });

test("a command is waited on for its own deadline plus the device's answer, its default when it names none", () => {
    expect(deviceCallDeadline(call("run_command", { command: "ls" }))?.ms).toBe(120_000 + DEVICE_ANSWER_MARGIN_MS);
    expect(deviceCallDeadline(call("run_command", { command: "ls", timeoutMs: 300_000 }))?.ms).toBe(300_000 + DEVICE_ANSWER_MARGIN_MS);
    // Past the tool's maximum, the device stops it at the maximum, so the bridge waits no longer than that either.
    expect(deviceCallDeadline(call("run_command", { command: "ls", timeoutMs: 3_600_000 }))?.ms).toBe(600_000 + DEVICE_ANSWER_MARGIN_MS);
});

test("the agent's client outwaits every bridge deadline", () => {
    for (const message of [call("run_command", { timeoutMs: 600_000 }), call("screenshot"), call("list_sandboxes")]) {
        expect(deviceCallDeadline(message)?.ms ?? 0).toBeLessThan(DEVICE_CLIENT_TIMEOUT_MS);
    }
    expect(DEVICE_CALL_CEILING_MS).toBeLessThan(DEVICE_CLIENT_TIMEOUT_MS);
});

test("a call that answers in seconds is given up on early, and says it may still be stuck", () => {
    const quick = deviceCallDeadline(call("screenshot"));
    expect(quick?.ms).toBe(QUICK_CALL_MS);
    expect(quick?.passed("omen")).toContain("may still be running there, or be stuck");
});

test("the message says which deadline passed and what it left running", () => {
    const own = deviceCallDeadline(call("run_command", { timeoutMs: 60_000 }))?.passed("rog") ?? "";
    expect(own).toContain("its own timeoutMs (60 s)");
    expect(own).toContain("most likely been stopped");
    expect(deviceCallDeadline(call("app_status", { waitFor: "ready" }))?.passed("rog")).toContain("keeps running on the device");
});

test("only a tool call carries a deadline", () => {
    expect(deviceCallDeadline({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toBeUndefined();
});
