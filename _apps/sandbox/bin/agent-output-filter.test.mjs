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

    it("drops npm warn noise on success and appends the footer with the log path", () => {
        const raw = "npm warn deprecated foo@1: gone\nnpm warn deprecated bar@2: gone\nadded 100 packages in 2s\n";
        const out = run(raw, { command: "npm ci", log: "/logs/terminals/agent-abc-%1.log" });
        expect(out).toContain("added 100 packages in 2s");
        expect(out).not.toContain("deprecated");
        expect(out).toContain("--- [exit 0, 1s] 3 lines filtered to 1 · full: retrieve-output /logs/terminals/agent-abc-%1.log [pattern]");
    });

    it("keeps npm warn lines on failure", () => {
        const raw = "npm warn deprecated foo@1: gone\nnpm ERR! code E404\n";
        expect(run(raw, { command: "npm ci", exit: "1" })).toBe(raw);
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
        const raw = "npm warn deprecated foo@1: gone\n";
        const out = run(raw, { command: "npm install" });
        expect(out).toContain("(no notable output)");
        expect(out).toContain("1 lines filtered to 0");
    });

    it("omits the log pointer when no log path is known", () => {
        const out = run("npm warn old\nok\n", { command: "npm i" });
        expect(out).toContain("filtered to 1");
        expect(out).not.toContain("retrieve-output");
    });

    // The attribution the savings report is built on. Two properties matter and neither is about any single
    // mechanism: every byte between raw and emitted is accounted for by SOME stage, and the footer is on the
    // ledger as the cost it is rather than quietly netted out of the savings it bought.
    it("attributes every byte between raw and emitted to a stage", () => {
        const raw = "\x1b[32mnpm warn deprecated foo@1: gone\x1b[0m\nadded 100 packages in 2s\n";
        const { out, stages } = filterOutput(raw, "npm ci", "0", "1", "/logs/x.log");
        const attributed = stages.reduce((sum, stage) => sum + stage.saved, 0);
        expect(attributed).toBe(raw.length - out.length);
        expect(stages.map((stage) => stage.id)).toContain("ansi");
        expect(stages.map((stage) => stage.id)).toContain("npm");
    });

    it("records the retrieval footer as a cost, not a saving", () => {
        const raw = "npm warn deprecated foo@1: gone\nadded 100 packages in 2s\n";
        const footer = stagesOf(raw, { command: "npm ci", log: "/logs/x.log" }).find((stage) => stage.id === "footer");
        expect(footer.saved).toBeLessThan(0);
    });
});
