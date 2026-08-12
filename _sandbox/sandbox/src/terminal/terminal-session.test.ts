import { expect, test } from "vitest";
import { jobSessionLabel, panePidSessions, reapableSessions } from "./terminal-session.js";

/* The retention sweep's policy. What it must never do is take something someone is using or something still
 * working — everything else it takes costs nothing, because the pane's bytes are already in the terminal logs.
 * `tmux list-panes -a -F '#{session_name} #{session_attached} #{session_activity} #{pane_dead}'`. */

const NOW = 1_780_000_000_000;
const HOUR = 3_600_000;
const at = (msAgo: number): number => Math.round((NOW - msAgo) / 1000);

type Pane = [session: string, attached: 0 | 1, agoMs: number, dead: 0 | 1];
const listPanes = (...panes: Pane[]): string =>
    panes.map(([session, attached, agoMs, dead]) => `${session} ${attached} ${at(agoMs)} ${dead}`).join("\n");

const nothingWorking = (): boolean => false;
const reap = (stdout: string, keep: (session: string) => boolean = nothingWorking): string[] => reapableSessions(stdout, NOW, keep);

test("finished job sessions age out; the ones that just finished stay", () => {
    const stdout = listPanes(["job-capability-demo", 0, 5 * HOUR, 1], ["job-recent", 0, 10 * 60_000, 1]);
    expect(reap(stdout)).toEqual(["job-capability-demo"]);
});

test("agent-* sessions are not this sweep's — they retire on their conversation's stop clock (platform/reaper.ts)", () => {
    expect(reap(listPanes(["agent-old", 0, 300 * HOUR, 1]))).toEqual([]);
});

test("a session with ANY live pane is never reaped, however old its stamp", () => {
    // A long unattended job: one dead window from an earlier command, one still running.
    const stdout = listPanes(["job-busy", 0, 9 * HOUR, 1], ["job-busy", 0, 9 * HOUR, 0]);
    expect(reap(stdout)).toEqual([]);
});

test("an attached session is never reaped — a browser is looking at it right now", () => {
    expect(reap(listPanes(["job-watched", 1, 9 * HOUR, 1]))).toEqual([]);
});

test("`keep` spares work the panes can't see: a job whose runner has more queued", () => {
    const stdout = listPanes(["job-slow", 0, 3 * HOUR, 1], ["job-infra-check", 0, 3 * HOUR, 1]);
    expect(reap(stdout, (session) => session === "job-slow")).toEqual(["job-infra-check"]);
});

test("web-* shells keep their own, far longer clock — they are the user's own places, not records", () => {
    const stdout = listPanes(["web-yesterday", 0, 20 * HOUR, 1], ["web-abandoned", 0, 60 * HOUR, 1]);
    expect(reap(stdout)).toEqual(["web-abandoned"]);
});

test("panel-* dev servers are never aged out — they are started and stopped explicitly", () => {
    expect(reap(listPanes(["panel-app", 0, 200 * HOUR, 1], ["panel-docker", 0, 200 * HOUR, 1]))).toEqual([]);
});

test("an unreadable activity stamp reads as just-now, so the sweep leaves it alone", () => {
    expect(reap("job-nostamp 0  1")).toEqual([]);
});

test("no tmux server (empty output) and blank lines yield nothing", () => {
    expect(reap("")).toEqual([]);
    expect(reap("\n\n")).toEqual([]);
});

/* The pane→session map the port scan walks a listener's ancestry against. A pane whose pid doesn't parse is
 * skipped rather than defaulted: a wrong name here sends someone to another terminal entirely. */
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

/* What a job session is CALLED. The id is the daemon's (sockets, kill routes, the reveal); the label is the
 * only part a person reads, and `job-checks` in front of an owner mid-push answered none of the questions they
 * had. */
test("a job session reads as a name rather than as its id", () => {
    expect(jobSessionLabel("job-checks")).toBe("Checks");
    expect(jobSessionLabel("job-capability-demo")).toBe("Capability demo");
});
