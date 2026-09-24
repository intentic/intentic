import { describe, it, expect } from "bun:test";
import { filterOutput, maskedFailure } from "./agent-output-filter.mjs";

// A retain that keeps nothing on disk and answers with `log`: the path the footer should then name.
const keptAt = (log) => (log === "" ? undefined : () => log);

// run() reads only `.out`; `stagesOf` is for tests that check the per-mechanism attribution.
const filtered = (raw, { command = "some-cmd", exit = "0", duration = "1", log = "", pipeline = "" } = {}) =>
    filterOutput(raw, { command, exitCode: exit, durationS: duration, retain: keptAt(log), pipeline });
const run = (raw, options) => filtered(raw, options).out;
const stagesOf = (raw, options) => filtered(raw, options).stages;

describe("filterOutput", () => {
    it("strips ANSI codes and collapses \\r progress frames to the final frame", () => {
        const raw = "\x1b[32mgreen\x1b[0m\nprogress 10%\rprogress 50%\rprogress 100%\n";
        expect(run(raw)).toBe("green\nprogress 100%\n");
    });

    it("returns unchanged output verbatim with no footer", () => {
        const raw = "line one\nline two\n";
        expect(run(raw)).toBe(raw);
    });

    it("drops pnpm progress noise on success and appends the footer counts", () => {
        const noise = Array.from({ length: 6 }, (_, i) => `Progress: resolved ${i}00, reused ${i}00, downloaded 0, added 0`);
        const raw = `${[...noise, "added 100 packages in 2s"].join("\n")}\n`;
        const out = run(raw, { command: "pnpm install", log: "/logs/terminals/agent-abc-%1.log" });
        expect(out).toContain("added 100 packages in 2s");
        expect(out).not.toContain("Progress:");
        expect(out).toContain("--- [exit 0, 1s] 7 lines filtered to 1");
        expect(out).not.toContain("retrieve-output");
    });

    it("appends the retrieval handle once the trim is big enough to be worth following", () => {
        const noise = Array.from({ length: 40 }, (_, i) => `Progress: resolved ${i}00, reused ${i}00, downloaded 0, added 0`);
        const raw = `${[...noise, "added 100 packages in 2s"].join("\n")}\n`;
        const out = run(raw, { command: "pnpm install", log: "/logs/terminals/agent-abc-%1.log" });
        expect(out).toContain("--- [exit 0, 1s] 41 lines filtered to 1 · full: retrieve-output /logs/terminals/agent-abc-%1.log [pattern]");
    });

    it("keeps pnpm progress lines on failure", () => {
        const raw = "Progress: resolved 100, reused 100, downloaded 0, added 0\nERR_PNPM_FETCH_404\n";
        expect(run(raw, { command: "pnpm install", exit: "1" })).toBe(raw);
    });

    it("caps long success output to head + tail with an elision marker", () => {
        const raw = `${Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")}\n`;
        const out = run(raw);
        expect(out).toContain("line 0");
        expect(out).toContain("line 29");
        expect(out).toContain("… 220 lines elided …");
        expect(out).not.toContain("line 100\n");
        expect(out).toContain("line 299");
        expect(out).toContain("300 lines filtered to 81");
    });

    it("keeps failures whole up to a generous tail cap", () => {
        const raw = `${Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n")}\n`;
        const out = run(raw, { exit: "2" });
        expect(out).not.toContain("line 50\n");
        expect(out).toContain("… 100 earlier lines elided …");
        expect(out).toContain("line 599");
        const short = `${raw.split("\n").slice(0, 300).join("\n")}\n`;
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

    it("attributes every byte between raw and emitted to a stage", () => {
        const raw = `\x1b[32m${Array.from({ length: 6 }, (_, i) => `Progress: resolved ${i}00, reused 0, downloaded 0, added 0`).join("\n")}\x1b[0m\nadded 100 packages in 2s\n`;
        const { out, stages } = filtered(raw, { command: "pnpm install", log: "/logs/x.log" });
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

    it("names a cut inside lines with a footer and the retained copy, which keeps every character", () => {
        const blob = "q".repeat(20_000);
        const raw = `{"data":"${blob}"}\n`;
        let kept;
        const { out } = filterOutput(raw, {
            command: "curl -s http://api/x",
            retain: (text) => {
                kept = text;
                return "/logs/raw-output/agent-abc-%1.log";
            },
        });
        expect(out).toMatch(/… \d+ chars elided …/);
        expect(out.endsWith("--- [exit 0, 0s] long runs cut inside lines · full: retrieve-output /logs/raw-output/agent-abc-%1.log [pattern]\n")).toBe(true);
        expect(kept).toBe(`{"data":"${blob}"}`);
    });

    it("keeps nothing when nothing was removed", () => {
        let asked = false;
        const out = filterOutput("one\ntwo\n", {
            retain: () => {
                asked = true;
                return "/logs/x.log";
            },
        }).out;
        expect(out).toBe("one\ntwo\n");
        expect(asked).toBe(false);
    });

    it("reports an earlier pipeline stage's failure that the exit code hides", () => {
        const raw = "Tests  3 failed | 40 passed (43)\n";
        expect(run(raw, { command: "pnpm vitest run | tail -1", pipeline: "1 0" })).toBe(
            `${raw}--- [exit 0 (pipeline: 1 0 — an earlier stage failed), 1s]\n`,
        );
    });

    it("says it inside the footer when there is one", () => {
        const raw = `${Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")}\n`;
        const out = run(raw, { pipeline: "2 0 0" });
        expect(out.split("\n").at(-2)).toBe("--- [exit 0 (pipeline: 2 0 0 — an earlier stage failed), 1s] 300 lines filtered to 81");
    });

    it("reads a SIGPIPE'd writer, a clean pipeline and a failed last stage as nothing masked", () => {
        const raw = "match\n";
        expect(run(raw, { command: "rg x | head -1", pipeline: "141 0" })).toBe(raw);
        expect(run(raw, { pipeline: "0 0" })).toBe(raw);
        expect(run(raw, { pipeline: "0" })).toBe(raw);
        expect(run(raw, { exit: "1", pipeline: "1 1" })).toBe(raw);
        expect(maskedFailure("0", "1 141 0")).toBe("1 141 0");
        expect(maskedFailure("0", "garbage 0")).toBeUndefined();
    });

    it("keeps the masked-failure line even when the guard hands back the raw capture", () => {
        const { out, stages } = filtered("a\na\na\n", { command: "cat flags.txt | cat", pipeline: "1 0" });
        expect(out).toBe("a\na\na\n--- [exit 0 (pipeline: 1 0 — an earlier stage failed), 1s]\n");
        expect(stages.reduce((sum, stage) => sum + stage.saved, 0)).toBe("a\na\na\n".length - out.length);
    });

    it("names rg's -r as --replace when a grep-style cluster rewrote the matches", () => {
        const raw = "package.json:        \"ci:audit\": \"node _tools/scripts/n.mjs\",\n";
        expect(run(raw, { command: 'cd /work/intentic && rg -rn "ci-audit" package.json | head -5' })).toBe(
            `${raw}--- note: \`-rn\` is not recursive in rg: -r is --replace, so matched text above was rewritten (rg recurses by default)\n`,
        );
        // A deliberate replacement, grep itself, and a search with no output say nothing.
        expect(run(raw, { command: "rg 'ci-(\\w+)' -r '$1' package.json" })).toBe(raw);
        expect(run(raw, { command: "grep -rn ci-audit ." })).toBe(raw);
        expect(run("", { command: "rg -rl ci-audit .", exit: "1" })).toBe("");
    });

    it("books nothing when the guard returns the raw capture", () => {
        // Three one-char lines: dedup's marker text would be longer than the output it replaces, tripping guard.
        const raw = "a\na\na\n";
        const { out, stages } = filtered(raw, { command: "cat flags.txt", log: "/logs/terminals/agent-abc-%1.log" });
        expect(out).toBe(raw);
        expect(stages.reduce((sum, stage) => sum + stage.saved, 0)).toBe(0);
        expect(stages.map((stage) => stage.id)).toContain("guard");
    });
});
