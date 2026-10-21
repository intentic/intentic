import { AGENT_VERB, runStop } from "./agent.js";

/* THE TWO THINGS ABOUT THIS TOOL THAT ARE DECISIONS RATHER THAN PLUMBING. */

/* RESTART IS BARE `run`, and every op is a task: a run that finds nothing to do exits at once, and that is no crash. */
test("every op maps to the CLI verb that actually performs it", () => {
    expect(AGENT_VERB).toEqual({
        // The whole machine, whichever side was asked: the command itself reaches the rest of the PC.
        upgrade: ["upgrade"],
        restart: ["run"],
        "forget-unreachable": ["device", "forget-unreachable"],
    });
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
