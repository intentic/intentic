import { ReadRestartIntentSchema, RESTART_ACTIONS, RESTART_INITIATORS, RESTART_SIDES, type RestartIntent, RestartIntentSchema } from "./restart-intent.js";

// The one schema every writer of /history/logs/restart-intent.json is held to; the daemon's golden/host-files.json carries its
// enumerations and an example for ic's Rust and the keeper's test to read back (host-files.test.ts).

const intent: RestartIntent = {
    at: "2026-10-05T22:45:30.000Z",
    by: "keeper",
    host: "rog",
    side: "wsl",
    action: "restart",
    reason: "the sandbox's /health stopped answering",
    checks: ["health"],
};

test("an intent a writer may leave reads back, to the field", () => {
    expect(RestartIntentSchema.parse(intent)).toEqual(intent);
    expect(RestartIntentSchema.parse({ at: intent.at, by: "daemon", action: "stop", reason: "idle-stop" })).toEqual({ at: intent.at, by: "daemon", action: "stop", reason: "idle-stop" });
});

test.each([
    ["an initiator nobody is", { ...intent, by: "netd" }],
    ["an action nothing does", { ...intent, action: "kill" }],
    ["a side no computer has", { ...intent, side: "macos" }],
    ["a moment that is not one", { ...intent, at: "yesterday" }],
    ["no reason", { at: intent.at, by: "ic", action: "restart" }],
])("a writer cannot leave %s", (_what, body) => {
    expect(RestartIntentSchema.safeParse(body).success).toBe(false);
});

// A writer newer than the daemon reading it: still an intent, in the words it used.
test("the daemon reads what a newer writer names, and only an unreadable moment or a missing reason is no intent", () => {
    const newer = { at: intent.at, by: "netd", side: "macos", action: "kill", reason: "stuck" };
    expect(ReadRestartIntentSchema.parse(newer)).toEqual(newer);
    expect(ReadRestartIntentSchema.safeParse({ ...newer, at: "yesterday" }).success).toBe(false);
    expect(ReadRestartIntentSchema.safeParse({ at: intent.at, by: "", action: "kill", reason: "x" }).success).toBe(false);
});

test("the enumerations are the words every writer and the reader share", () => {
    expect([RESTART_INITIATORS, RESTART_ACTIONS, RESTART_SIDES]).toEqual([
        ["owner", "daemon", "ic", "keeper", "desktop"],
        ["restart", "stop", "update", "swap", "reshape", "recreate", "rebuild"],
        ["wsl", "windows", "linux", "mac"],
    ]);
});
