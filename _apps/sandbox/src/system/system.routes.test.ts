import { expect, test } from "vitest";
import { paneStates } from "./system.routes.js";

// `tmux list-panes -a -F '#{session_name}\t#{pane_dead}\t#{pane_current_command}'` — one line per pane, so a
// multi-window session (every agent-* one: bin/tmux-run opens a window per Bash command and keeps the finished
// ones under remain-on-exit) reports many.
const listPanes = (...panes: [session: string, dead: 0 | 1, command: string][]): string =>
    panes.map(([session, dead, command]) => `${session}\t${dead}\t${command}`).join("\n");

test("a session is live while ANY of its panes is, and finished once every one is dead", () => {
    const states = paneStates(
        listPanes(
            // Mid-turn: the previous commands' windows are dead, the current one is running.
            ["agent-3f2a9b1c", 1, ""],
            ["agent-3f2a9b1c", 1, ""],
            ["agent-3f2a9b1c", 0, "pnpm"],
            // The turn ended — every window is a finished command's dead pane.
            ["agent-7c0e1ad7", 1, ""],
            ["agent-7c0e1ad7", 1, ""],
            ["web-a1b2c3d4", 0, "zsh"],
        ),
    );
    expect(states.get("agent-3f2a9b1c")?.live).toBe(true);
    expect(states.get("agent-7c0e1ad7")?.live).toBe(false);
    expect(states.get("web-a1b2c3d4")?.live).toBe(true);
});

test("pane order doesn't matter — a live pane after dead ones still counts", () => {
    expect(paneStates(listPanes(["agent-1", 0, "vitest"], ["agent-1", 1, ""])).get("agent-1")?.live).toBe(true);
    expect(paneStates(listPanes(["agent-1", 1, ""], ["agent-1", 0, "vitest"])).get("agent-1")?.live).toBe(true);
});

test("the reported command is the session's last pane — single-pane panel-* sessions read their foreground process", () => {
    const states = paneStates(listPanes(["panel-app", 0, "node"], ["panel-docker", 0, "zsh"]));
    expect(states.get("panel-app")?.command).toBe("node");
    expect(states.get("panel-docker")?.command).toBe("zsh");
});

test("no tmux server (empty output) and blank lines yield nothing", () => {
    expect(paneStates("")).toEqual(new Map());
    expect(paneStates("\n\n")).toEqual(new Map());
});

test("an unparseable pane_dead reads as live — the flag gates a destructive sweep", () => {
    expect(paneStates("agent-1\t\tzsh").get("agent-1")?.live).toBe(true);
});
