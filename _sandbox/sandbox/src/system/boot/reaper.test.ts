import { type AgentSessionState, parseAgentSessions, reapableAgentSessionNames, type TerminalPolicy } from "./reaper.js";

/* The terminal half of the reaper's policy: which agent sessions go, decided purely from what tmux lists and the owner stop clock. */

const NOW = 1_780_000_000_000;
const MINUTE = 60_000;
const GRACE = 10 * MINUTE;
const IDLE = 60 * MINUTE;

const session = (overrides: Partial<AgentSessionState> & { name: string }): AgentSessionState => ({
    owner: "conv-1",
    attached: false,
    // Just used, so the idle ceiling never decides a test that is not about it.
    activityAt: NOW - MINUTE,
    ...overrides,
});

const policy = (overrides: Partial<TerminalPolicy> = {}): TerminalPolicy => ({
    // Every owner stopped an hour ago unless a test says otherwise.
    ownerStoppedSince: () => NOW - 60 * MINUTE,
    liveNames: new Set<string>(),
    graceMs: GRACE,
    idleMs: IDLE,
    ...overrides,
});

test("a stopped conversation's session goes once the grace has passed: live panes are not a defence", () => {
    expect(reapableAgentSessionNames([session({ name: "agent-a" })], NOW, policy())).toEqual(["agent-a"]);
});

test("a session in use goes neither while its owner runs nor before the grace is up", () => {
    expect(reapableAgentSessionNames([session({ name: "agent-a" })], NOW, policy({ ownerStoppedSince: () => undefined }))).toEqual([]);
    expect(reapableAgentSessionNames([session({ name: "agent-a" })], NOW, policy({ ownerStoppedSince: () => NOW - GRACE + MINUTE }))).toEqual([]);
});

// The case the stop clock structurally cannot reach: a conversation that goes on working never stops, so every
// session it has replaced is held, and so is whatever is stuck inside one.
test("a working owner's stale session still goes, on the session's own clock", () => {
    const stale = session({ name: "agent-stale", activityAt: NOW - IDLE });
    const recent = session({ name: "agent-recent", activityAt: NOW - IDLE + MINUTE });
    const live = policy({ ownerStoppedSince: () => undefined });
    expect(reapableAgentSessionNames([stale, recent], NOW, live)).toEqual(["agent-stale"]);
});

test("the idle ceiling yields to the two absolutes: attached, and a turn in flight", () => {
    const stale = { name: "agent-stale", owner: "conv-1", attached: false, activityAt: NOW - 10 * IDLE };
    const live = policy({ ownerStoppedSince: () => undefined });
    expect(reapableAgentSessionNames([{ ...stale, attached: true }], NOW, live)).toEqual([]);
    expect(reapableAgentSessionNames([stale], NOW, policy({ ownerStoppedSince: () => undefined, liveNames: new Set(["agent-stale"]) }))).toEqual([]);
});

test("attached is absolute: someone is looking at it, whatever its owner's clock says", () => {
    expect(reapableAgentSessionNames([session({ name: "agent-a", attached: true })], NOW, policy())).toEqual([]);
});

test("a live turn's session is never reaped even when its owner attribution failed", () => {
    const unattributed = session({ name: "agent-a", owner: undefined, activityAt: NOW - 60 * MINUTE });
    expect(reapableAgentSessionNames([unattributed], NOW, policy({ liveNames: new Set(["agent-a"]) }))).toEqual([]);
});

test("an unowned session is judged by its own idle clock against the same grace", () => {
    const idle = session({ name: "agent-idle", owner: undefined, activityAt: NOW - GRACE });
    const busy = session({ name: "agent-busy", owner: undefined, activityAt: NOW - MINUTE });
    expect(reapableAgentSessionNames([idle, busy], NOW, policy())).toEqual(["agent-idle"]);
});

test("only agent-* sessions are parsed: the sweep cannot even see the user's shells", () => {
    const stdout = ["agent-a1b2c3d4\tconv-1\t0\t1779996400", "web-1234\t\t1\t1779996400", "panel-app\t\t0\t1779996400", ""].join("\n");
    const sessions = parseAgentSessions(stdout, NOW);
    expect(sessions).toEqual([{ name: "agent-a1b2c3d4", owner: "conv-1", attached: false, activityAt: 1_779_996_400_000 }]);
});

test("an empty owner field parses as unowned, and a blank activity stamp reads as just-now", () => {
    const sessions = parseAgentSessions("agent-a\t\t0\t\n", NOW);
    expect(sessions).toEqual([{ name: "agent-a", owner: undefined, attached: false, activityAt: NOW }]);
});

test("no tmux server (empty output) yields nothing", () => {
    expect(parseAgentSessions("", NOW)).toEqual([]);
});
