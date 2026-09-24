import { CHECKS_SESSION, jobSessionLabel, panePidSessions, PUSH_SESSION, type ReapPolicy, reapableSessions } from "./terminal-session.js";

/* The retention sweep's policy. */

const NOW = 1_780_000_000_000;
const HOUR = 3_600_000;
const at = (msAgo: number): number => Math.round((NOW - msAgo) / 1000);

type Pane = [session: string, attached: 0 | 1, agoMs: number, dead: 0 | 1];
const listPanes = (...panes: Pane[]): string =>
    panes.map(([session, attached, agoMs, dead]) => `${session} ${attached} ${at(agoMs)} ${dead}`).join("\n");

// Neither half of the policy knows anything unless a case says so: nothing is still working, nothing was a one-shot
// run.
const idlePolicy: ReapPolicy = { keep: () => false, finishedRunAt: () => undefined };
const reap = (stdout: string, policy: Partial<ReapPolicy> = {}): string[] => reapableSessions(stdout, NOW, { ...idlePolicy, ...policy });

test("finished job sessions age out; the ones that just finished stay", () => {
    const stdout = listPanes(["job-capability-demo", 0, 5 * HOUR, 1], ["job-recent", 0, 10 * 60_000, 1]);
    expect(reap(stdout)).toEqual(["job-capability-demo"]);
});

test("agent-* sessions are not this sweep's, they retire on their conversation's stop clock (platform/reaper.ts)", () => {
    expect(reap(listPanes(["agent-old", 0, 300 * HOUR, 1]))).toEqual([]);
});

test("a session with ANY live pane is never reaped, however old its stamp", () => {
    // A long unattended job: one dead window from an earlier command, one still running.
    const stdout = listPanes(["job-busy", 0, 9 * HOUR, 1], ["job-busy", 0, 9 * HOUR, 0]);
    expect(reap(stdout)).toEqual([]);
});

test("an attached session is never reaped: a browser is looking at it right now", () => {
    expect(reap(listPanes(["job-watched", 1, 9 * HOUR, 1]))).toEqual([]);
});

test("`keep` spares work the panes can't see: a job whose runner has more queued", () => {
    const stdout = listPanes(["job-slow", 0, 3 * HOUR, 1], ["job-infra-check", 0, 3 * HOUR, 1]);
    expect(reap(stdout, { keep: (session) => session === "job-slow" })).toEqual(["job-infra-check"]);
});

test("web-* shells keep their own, far longer clock: they are the user's own places, not records", () => {
    const stdout = listPanes(["web-yesterday", 0, 20 * HOUR, 1], ["web-abandoned", 0, 60 * HOUR, 1]);
    expect(reap(stdout)).toEqual(["web-abandoned"]);
});

test("panel-* dev servers are never aged out: they are started and stopped explicitly", () => {
    expect(reap(listPanes(["panel-app", 0, 200 * HOUR, 1], ["panel-docker", 0, 200 * HOUR, 1]))).toEqual([]);
});

/* A one-shot run (an install, a project's checks) leaves its shell sitting at a prompt, so its pane is alive and
 * its session looks exactly like a dev server nobody has typed in. Only the process manager knows it ended, which
 * is why the sweep asks rather than reads it off tmux. */
test("a finished one-shot run ages out on the manager's stamp, though its shell is alive at a prompt", () => {
    const stdout = listPanes(["panel-root--verify", 0, 0, 0], ["panel-web--install", 0, 0, 0]);
    const finishedRunAt = (session: string): number | undefined => (session === "panel-root--verify" ? NOW - 5 * HOUR : NOW - 10 * 60_000);

    expect(reap(stdout, { finishedRunAt })).toEqual(["panel-root--verify"]);
});

test("an unreadable activity stamp reads as just-now, so the sweep leaves it alone", () => {
    expect(reap("job-nostamp 0  1")).toEqual([]);
});

test("no tmux server (empty output) and blank lines yield nothing", () => {
    expect(reap("")).toEqual([]);
    expect(reap("\n\n")).toEqual([]);
});

/* The port scan ignores panes whose process id cannot be parsed. */
test("panePidSessions maps each pane's root pid to its session, skipping lines with no usable pid", () => {
    expect(panePidSessions("web-3f2a 397\npanel-docker 247\n")).toEqual(
        new Map([
            [397, "web-3f2a"],
            [247, "panel-docker"],
        ]),
    );
    expect(panePidSessions("")).toEqual(new Map());
    expect(panePidSessions("web-broken \nweb-negative -1\nweb-nan abc\n 500\n")).toEqual(new Map());
});

/* Job sessions use daemon ids and display labels. */
test("a job session reads as a name rather than as its id", () => {
    expect(jobSessionLabel(CHECKS_SESSION)).toBe("Checks");
    expect(jobSessionLabel(PUSH_SESSION)).toBe("Push");
    expect(jobSessionLabel("job-capability-demo")).toBe("Capability demo");
});
