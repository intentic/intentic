import { AGENT_VERB, agentArgv, runStop } from "./agent.js";

/* THE TWO THINGS ABOUT THIS TOOL THAT ARE DECISIONS RATHER THAN PLUMBING. */

/* RESTART IS BARE `run`, and every op is a task: a run that finds nothing to do exits at once, and that is no crash. */
test("every op maps to the CLI verb that actually performs it", () => {
    expect(AGENT_VERB).toEqual({
        // The whole machine, whichever side was asked: the command itself reaches the rest of the PC.
        upgrade: ["upgrade"],
        restart: ["run"],
        "forget-unreachable": ["device", "forget-unreachable"],
        // The owner's yes to keeping this computer on while plugged in (power/), which restarts nothing.
        "power-stay-on": ["power", "stay-on"],
        // The owner's yes to a smaller WSL VM (environments/wslconfig-memory.ts), which restarts nothing either.
        "wsl-memory": ["wsl-memory", "apply"],
        // The owner's answers to Windows Update's night restarts (power/update-pause.ts, autostart/before-sign-in.ts).
        "update-pause": ["power", "pause-updates"],
        "before-sign-in": ["before-sign-in", "on"],
    });
});

// The moment is the one the card computed from the booked work; without one, nothing is paused.
test("update-pause carries the moment the pause ends, and refuses without one", () => {
    expect(agentArgv({ op: "update-pause", until: 1_764_313_200_000 })).toEqual(["power", "pause-updates", "--until", "1764313200000"]);
    expect(() => agentArgv({ op: "update-pause" })).toThrow("The update-pause op needs the moment the pause ends (until), and none came with it: nothing was changed.");
    expect(agentArgv({ op: "before-sign-in" })).toEqual(["before-sign-in", "on"]);
});

// The size is the one the owner approved on the card, never one this agent works out again; without one, nothing runs.
test("wsl-memory carries the size approved and why, and refuses without a size", () => {
    expect(agentArgv({ op: "wsl-memory", memoryGb: 15 }, () => "Windows was short")).toEqual(["wsl-memory", "apply", "--gb", "15", "--why", "Windows was short"]);
    expect(() => agentArgv({ op: "wsl-memory" })).toThrow("The wsl-memory op needs the size approved (memoryGb), and none came with it: nothing was changed.");
    expect(agentArgv({ op: "power-stay-on", memoryGb: 15 })).toEqual(["power", "stay-on"]);
});

/* A RUN THAT STOPPED IS A REFUSAL, not the settled sentence (2026-10-21: "Update finished" over an EPERM). */
test("the run's stop is read from its lines, with its problem and fix, and a run without one has none", () => {
    expect(runStop(["intentic:   100% of 46 MB", "intentic: Checked against the release's signed SHA256SUMS."])).toBeUndefined();
    expect(
        runStop([
            "intentic: Checked against the release's signed SHA256SUMS.",
            "error: EPERM: operation not permitted, rename 'C:\\a\\intentic-launch.exe' -> 'C:\\a\\intentic-launch.exe.previous'",
        ]),
    ).toBe("EPERM: operation not permitted, rename 'C:\\a\\intentic-launch.exe' -> 'C:\\a\\intentic-launch.exe.previous'");
    expect(runStop(["error: The agent was not updated.", "   problem: the download failed", "   fix:     intentic-machine upgrade", "agent started"])).toBe(
        "The agent was not updated.\n   problem: the download failed\n   fix:     intentic-machine upgrade",
    );
});
