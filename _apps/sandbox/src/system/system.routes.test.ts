import { expect, test } from "vitest";
import { paneStates } from "./system.routes.js";

// `tmux list-panes -a -F '#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{session_activity}\t#{pane_current_command}'`
// — one line per pane, so a multi-window session (every agent-* one: bin/tmux-run opens a window per Bash
// command and keeps the finished ones under remain-on-exit) reports many. `session_activity` is session-wide,
// so every line of a session repeats it; `pane_dead_status` is empty while the pane lives.
const ACTIVITY = 1_780_000_000;
type Pane = [session: string, dead: 0 | 1, status: string, command: string];
const listPanes = (...panes: Pane[]): string =>
    panes.map(([session, dead, status, command]) => `${session}\t${dead}\t${status}\t${ACTIVITY}\t${command}`).join("\n");

test("a session is live while ANY of its panes is, and finished once every one is dead", () => {
    const states = paneStates(
        listPanes(
            // Mid-turn: the previous commands' windows are dead, the current one is running.
            ["agent-3f2a9b1c", 1, "0", ""],
            ["agent-3f2a9b1c", 1, "0", ""],
            ["agent-3f2a9b1c", 0, "", "pnpm"],
            // The turn ended — every window is a finished command's dead pane.
            ["agent-7c0e1ad7", 1, "0", ""],
            ["agent-7c0e1ad7", 1, "0", ""],
            ["web-a1b2c3d4", 0, "", "zsh"],
        ),
    );
    expect(states.get("agent-3f2a9b1c")?.live).toBe(true);
    expect(states.get("agent-7c0e1ad7")?.live).toBe(false);
    expect(states.get("web-a1b2c3d4")?.live).toBe(true);
});

test("pane order doesn't matter — a live pane after dead ones still counts", () => {
    expect(paneStates(listPanes(["agent-1", 0, "", "vitest"], ["agent-1", 1, "0", ""])).get("agent-1")?.live).toBe(true);
    expect(paneStates(listPanes(["agent-1", 1, "0", ""], ["agent-1", 0, "", "vitest"])).get("agent-1")?.live).toBe(true);
});

test("the reported command is the session's last pane — single-pane panel-* sessions read their foreground process", () => {
    const states = paneStates(listPanes(["panel-app", 0, "", "node"], ["panel-docker", 0, "", "zsh"]));
    expect(states.get("panel-app")?.command).toBe("node");
    expect(states.get("panel-docker")?.command).toBe("zsh");
});

// The exit status of the LAST window is the exit status of the last command — which is the one the dead pane's
// epitaph shows, and the only reason bin/tmux-run exits its runner with the command's own code.
test("the exit status is the last window's, and absent while that pane still runs", () => {
    const finished = paneStates(listPanes(["job-infra-check", 1, "0", ""], ["job-infra-check", 1, "1", ""]));
    expect(finished.get("job-infra-check")?.exitCode).toBe(1);

    const running = paneStates(listPanes(["job-infra-check", 1, "1", ""], ["job-infra-check", 0, "", "intentic"]));
    expect(running.get("job-infra-check")?.exitCode).toBeUndefined();
});

test("the activity stamp comes back in epoch MS, and an unreadable one reads as 0 — unknown, never 1970", () => {
    expect(paneStates(listPanes(["web-a1b2c3d4", 0, "", "zsh"])).get("web-a1b2c3d4")?.activityAt).toBe(ACTIVITY * 1000);
    expect(paneStates("web-a1b2c3d4\t0\t\t\tzsh").get("web-a1b2c3d4")?.activityAt).toBe(0);
});

test("no tmux server (empty output) and blank lines yield nothing", () => {
    expect(paneStates("")).toEqual(new Map());
    expect(paneStates("\n\n")).toEqual(new Map());
});

test("an unparseable pane_dead reads as live — the flag gates a destructive sweep", () => {
    expect(paneStates("agent-1\t\t\t\tzsh").get("agent-1")?.live).toBe(true);
});
