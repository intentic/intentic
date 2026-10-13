import { bypassModeOf, isBypassMode, modeFor, noteMode, planModeOf, recordModes, type SessionModes } from "./acp-modes.js";

// The modes three real agents advertise, as their session/new answers name them.
const DEVIN = [
    { id: "accept-edits", name: "Code" },
    { id: "smart", name: "Smart" },
    { id: "ask", name: "Ask" },
    { id: "plan", name: "Plan" },
    { id: "bypass", name: "Bypass Permissions" },
];
const CLAUDE = [
    { id: "default", name: "Default" },
    { id: "acceptEdits", name: "Accept Edits" },
    { id: "plan", name: "Plan Mode" },
    { id: "bypassPermissions", name: "Bypass Permissions" },
];
const CODEX = [
    { id: "read-only", name: "Read Only" },
    { id: "auto", name: "Auto" },
    { id: "full-access", name: "Full Access" },
];

const recorded = (available: SessionModes["available"], current: string): SessionModes => {
    const modes = new Map<string, SessionModes>();
    recordModes(modes, "s", { currentModeId: current, availableModes: [...available] });
    const state = modes.get("s");
    if (state === undefined) {
        throw new Error("no modes recorded");
    }
    return state;
};

test("plan and bypass modes are found by id or name, whatever the agent spells them", () => {
    expect([planModeOf({ available: DEVIN }), bypassModeOf({ available: DEVIN })]).toEqual(["plan", "bypass"]);
    expect([planModeOf({ available: CLAUDE }), bypassModeOf({ available: CLAUDE })]).toEqual(["plan", "bypassPermissions"]);
    expect([planModeOf({ available: CODEX }), bypassModeOf({ available: CODEX })]).toEqual([undefined, "full-access"]);
});

test("the home mode is the session's own, unless it opened in a plan or bypass mode", () => {
    expect(recorded(DEVIN, "accept-edits").home).toBe("accept-edits");
    expect(recorded(CLAUDE, "bypassPermissions").home).toBe("default");
});

test("a reloaded session keeps the home its first answer gave, whatever mode its last turn left it in", () => {
    const modes = new Map<string, SessionModes>();
    recordModes(modes, "s", { currentModeId: "accept-edits", availableModes: DEVIN });
    noteMode(modes, "s", "smart");
    recordModes(modes, "s", { currentModeId: "smart", availableModes: DEVIN });
    expect(modes.get("s")).toMatchObject({ current: "smart", home: "accept-edits" });
});

describe("where a phase puts the session", () => {
    const devin = recorded(DEVIN, "accept-edits");

    test("planning: the agent's plan mode, else its home", () => {
        expect(modeFor(devin, "plan", "plan", true)).toBe("plan");
        expect(modeFor(recorded(CODEX, "auto"), "plan", "plan", true)).toBe("auto");
    });

    test("approve each call: the home mode, whose asks reach a person", () => {
        expect(modeFor(devin, "execute", "default", false)).toBe("accept-edits");
    });

    test("run without asking: the bypass mode only while no rule is watching", () => {
        expect(modeFor(devin, "execute", "bypassPermissions", false)).toBe("bypass");
        expect(modeFor(devin, "execute", undefined, false)).toBe("bypass");
        expect(modeFor(devin, "execute", "bypassPermissions", true)).toBe("accept-edits");
    });
});

test("a bypass mode is told apart from the rest", () => {
    const devin = recorded(DEVIN, "accept-edits");
    expect([isBypassMode(devin, "bypass"), isBypassMode(devin, "smart")]).toEqual([true, false]);
});
