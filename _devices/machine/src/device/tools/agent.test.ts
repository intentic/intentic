import { AGENT_VERB } from "./agent.js";

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
