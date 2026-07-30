import { describe, expect, it } from "vitest";
import { filterOutput } from "./agent-output-filter.mjs";

// filterOutput returns the result AND its per-mechanism attribution; these assertions are about the result.
const run = (raw, { command = "some-cmd", exit = "0", duration = "1", log = "" } = {}) => filterOutput(raw, command, exit, duration, log).out;
const stagesOf = (raw, { command = "some-cmd", exit = "0", duration = "1", log = "" } = {}) => filterOutput(raw, command, exit, duration, log).stages;

describe("filterOutput", () => {
    it("strips ANSI codes and collapses \\r progress frames to the final frame", () => {
        const raw = "\x1b[32mgreen\x1b[0m\nprogress 10%\rprogress 50%\rprogress 100%\n";
        expect(run(raw)).toBe("green\nprogress 100%\n");
    });

    it("returns unchanged output verbatim with no footer", () => {
        const raw = "line one\nline two\n";
        expect(run(raw)).toBe(raw);
    });

    it("drops pnpm progress noise on success and appends the footer with the log path", () => {
        const noise = Array.from({ length: 6 }, (_, i) => `Progress: resolved ${i}00, reused ${i}00, downloaded 0, added 0`);
        const raw = `${[...noise, "added 100 packages in 2s"].join("\n")}\n`;
        const out = run(raw, { command: "pnpm install", log: "/logs/terminals/agent-abc-%1.log" });
        expect(out).toContain("added 100 packages in 2s");
        expect(out).not.toContain("Progress:");
        expect(out).toContain("--- [exit 0, 1s] 7 lines filtered to 1 · full: retrieve-output /logs/terminals/agent-abc-%1.log [pattern]");
    });

    it("keeps pnpm progress lines on failure", () => {
        const raw = "Progress: resolved 100, reused 100, downloaded 0, added 0\nERR_PNPM_FETCH_404\n";
        expect(run(raw, { command: "pnpm install", exit: "1" })).toBe(raw);
    });

    it("caps long success output to head + tail with an elision marker", () => {
        const raw = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n";
        const out = run(raw);
        expect(out).toContain("line 0");
        expect(out).toContain("line 29");
        expect(out).toContain("… 220 lines elided …");
        expect(out).not.toContain("line 100\n");
        expect(out).toContain("line 299");
        expect(out).toContain("300 lines filtered to 81");
    });

    it("keeps failures whole up to a generous tail cap", () => {
        const raw = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n") + "\n";
        const out = run(raw, { exit: "2" });
        expect(out).not.toContain("line 50\n");
        expect(out).toContain("… 100 earlier lines elided …");
        expect(out).toContain("line 599");
        // 300 lines on failure passes untouched.
        const short = raw.split("\n").slice(0, 300).join("\n") + "\n";
        expect(run(short, { exit: "2" })).toBe(short);
    });

    it("names an all-noise success instead of returning emptiness", () => {
        const raw = `${Array.from({ length: 6 }, (_, i) => `Progress: resolved ${i}00, reused ${i}00, downloaded 0, added 0`).join("\n")}\n`;
        const out = run(raw, { command: "pnpm install" });
        expect(out).toContain("(no notable output)");
        expect(out).toContain("6 lines filtered to 0");
    });

    it("omits the log pointer when no log path is known", () => {
        const raw = `${[...Array.from({ length: 6 }, (_, i) => `Progress: resolved ${i}00, reused 0, downloaded 0, added 0`), "ok"].join("\n")}\n`;
        const out = run(raw, { command: "pnpm i" });
        expect(out).toContain("filtered to 1");
        expect(out).not.toContain("retrieve-output");
    });

    // The attribution the savings report is built on. Two properties matter and neither is about any single
    // mechanism: every byte between raw and emitted is accounted for by SOME stage, and the footer is on the
    // ledger as the cost it is rather than quietly netted out of the savings it bought.
    it("attributes every byte between raw and emitted to a stage", () => {
        const raw = `\x1b[32m${Array.from({ length: 6 }, (_, i) => `Progress: resolved ${i}00, reused 0, downloaded 0, added 0`).join("\n")}\x1b[0m\nadded 100 packages in 2s\n`;
        const { out, stages } = filterOutput(raw, "pnpm install", "0", "1", "/logs/x.log");
        const attributed = stages.reduce((sum, stage) => sum + stage.saved, 0);
        expect(attributed).toBe(raw.length - out.length);
        expect(stages.map((stage) => stage.id)).toContain("ansi");
        expect(stages.map((stage) => stage.id)).toContain("pnpm");
    });

    it("records the retrieval footer as a cost, not a saving", () => {
        const raw = `${[...Array.from({ length: 6 }, (_, i) => `Progress: resolved ${i}00, reused 0, downloaded 0, added 0`), "added 100 packages"].join("\n")}\n`;
        const footer = stagesOf(raw, { command: "pnpm install", log: "/logs/x.log" }).find((stage) => stage.id === "footer");
        expect(footer.saved).toBeLessThan(0);
    });

    // The guard is the accounting's edge case as well as its safety net: when it hands the raw capture back, the
    // stages must sum to zero, or the ledger would book a saving the model never received.
    it("books nothing when the guard returns the raw capture", () => {
        // Three one-character lines: dedup's own "… (2 more identical lines)" marker is five times the output it
        // replaces. Collapsing repetition is nearly always a win and here it is not, which is what `guard` is for.
        const raw = "a\na\na\n";
        const { out, stages } = filterOutput(raw, "cat flags.txt", "0", "1", "/logs/terminals/agent-abc-%1.log");
        expect(out).toBe(raw);
        expect(stages.reduce((sum, stage) => sum + stage.saved, 0)).toBe(0);
        expect(stages.map((stage) => stage.id)).toContain("guard");
    });
});
