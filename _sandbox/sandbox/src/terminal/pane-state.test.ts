import { expect, test } from "vitest";
import { foreground, paneStates } from "./pane-state.js";

// One PANE_FORMAT line per pane, so a multi-window session reports many; session_activity repeats per line,
// pane_dead_status is empty while alive.
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
            // The turn ended: every window is a finished command's dead pane.
            ["agent-7c0e1ad7", 1, "0", ""],
            ["agent-7c0e1ad7", 1, "0", ""],
            ["web-a1b2c3d4", 0, "", "zsh"],
        ),
    );
    expect(states.get("agent-3f2a9b1c")?.live).toBe(true);
    expect(states.get("agent-7c0e1ad7")?.live).toBe(false);
    expect(states.get("web-a1b2c3d4")?.live).toBe(true);
});

test("pane order doesn't matter, a live pane after dead ones still counts", () => {
    expect(paneStates(listPanes(["agent-1", 0, "", "vitest"], ["agent-1", 1, "0", ""])).get("agent-1")?.live).toBe(true);
    expect(paneStates(listPanes(["agent-1", 1, "0", ""], ["agent-1", 0, "", "vitest"])).get("agent-1")?.live).toBe(true);
});

test("the reported command is the session's last pane: single-pane panel-* sessions read their foreground process", () => {
    const states = paneStates(listPanes(["panel-app", 0, "", "node"], ["panel-docker", 0, "", "zsh"]));
    expect(states.get("panel-app")?.command).toBe("node");
    expect(states.get("panel-docker")?.command).toBe("zsh");
});

// liveCommand, not command, is what the kill confirm reads: an agent session's live pane can sit mid-list behind
// finished ones, so `command` alone would read the corpse.
test("the live command skips finished panes, wherever in the list they fall", () => {
    const states = paneStates(listPanes(["agent-1", 1, "0", ""], ["agent-1", 0, "", "pnpm"], ["agent-1", 1, "0", ""]));
    expect(states.get("agent-1")?.command).toBe("");
    expect(states.get("agent-1")?.liveCommand).toBe("pnpm");
});

// Nothing alive means nothing running, whatever the last pane's exit status names.
test("a session whose every pane is dead has no live command", () => {
    expect(paneStates(listPanes(["job-checks", 1, "0", "vitest"], ["job-checks", 1, "1", "vitest"])).get("job-checks")?.liveCommand).toBeUndefined();
});

// An idle shell reports itself; foreground reads that as not busy, so a plain close asks nothing needless.
test("an idle shell's live command is the shell", () => {
    expect(paneStates(listPanes(["web-a1b2c3d4", 0, "", "zsh"])).get("web-a1b2c3d4")?.liveCommand).toBe("zsh");
    expect(paneStates(listPanes(["web-a1b2c3d4", 0, "", "pnpm"])).get("web-a1b2c3d4")?.liveCommand).toBe("pnpm");
});

// Shared by the kill confirm, the strip's dot, and the sampler's fingerprint; that's why it lives here.
test("a session is busy with whatever is in front of its shell, and with nothing at an idle prompt", () => {
    expect(foreground("pnpm")).toBe("pnpm");
    expect(foreground("zsh")).toBeUndefined();
    expect(foreground(undefined)).toBeUndefined();
});

// The last window's exit status is the last command's, why bin/tmux-run exits with the command's own code.
test("the exit status is the last window's, and absent while that pane still runs", () => {
    const finished = paneStates(listPanes(["job-infra-check", 1, "0", ""], ["job-infra-check", 1, "1", ""]));
    expect(finished.get("job-infra-check")?.exitCode).toBe(1);

    const running = paneStates(listPanes(["job-infra-check", 1, "1", ""], ["job-infra-check", 0, "", "intentic"]));
    expect(running.get("job-infra-check")?.exitCode).toBeUndefined();
});

test("the activity stamp comes back in epoch MS, and an unreadable one reads as 0: unknown, never 1970", () => {
    expect(paneStates(listPanes(["web-a1b2c3d4", 0, "", "zsh"])).get("web-a1b2c3d4")?.activityAt).toBe(ACTIVITY * 1000);
    expect(paneStates("web-a1b2c3d4\t0\t\t\tzsh").get("web-a1b2c3d4")?.activityAt).toBe(0);
});

test("no tmux server (empty output) and blank lines yield nothing", () => {
    expect(paneStates("")).toEqual(new Map());
    expect(paneStates("\n\n")).toEqual(new Map());
});

test("an unparseable pane_dead reads as live: the flag gates a destructive sweep", () => {
    expect(paneStates("agent-1\t\t\t\tzsh").get("agent-1")?.live).toBe(true);
});
