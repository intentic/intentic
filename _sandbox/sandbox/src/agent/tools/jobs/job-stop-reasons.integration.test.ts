import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliStopSentence, markJobStopped } from "./job-stop-reasons.js";

// 2026-11-17, the shinobi-society audit: capture batches Claude Code stopped at ~120 minutes ended on a bare 143.
describe("cliStopSentence", () => {
    it("names the time limit and how long the command ran when the CLI said so", () => {
        expect(cliStopSentence(7_200_000, "Background command stopped after reaching its time limit")).toBe(
            'stopped by Claude Code at its background time limit after 2h 0m (it said: "Background command stopped after reaching its time limit"), not by the agent or the person. Split it into steps that each finish sooner, or, for a server meant to keep running, hand it to the person with the keep tool, which this limit does not end.',
        );
    });

    it("names memory when the CLI blamed memory", () => {
        expect(cliStopSentence(14 * 60_000 + 59_000, "stopped: memory pressure")).toMatch(/^stopped by Claude Code because memory was running short after 14m \(/);
    });

    it("names both of the CLI's limits when it said nothing", () => {
        expect(cliStopSentence(45_000)).toMatch(/^stopped by Claude Code by itself \(its background time limit, about 2 hours, or memory running short\) after 45s, not by/);
    });
});

describe("markJobStopped", () => {
    it("writes the reason once and says it once in the output", () => {
        const dir = mkdtempSync(join(tmpdir(), "intentic-run-stop-"));
        writeFileSync(join(dir, "out"), "frame 41\n");
        expect(markJobStopped(dir, "first")).toBe(true);
        expect(markJobStopped(dir, "second")).toBe(false);
        expect(readFileSync(join(dir, "stop-reason"), "utf8")).toBe("first\n");
        expect(readFileSync(join(dir, "out"), "utf8")).toBe("frame 41\n\n--- intentic: first\n");
    });
});
