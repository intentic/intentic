import { describe, expect, it } from "vitest";
import { asLabel, createUi, estimate, humanDuration, truncate, wrap, type UiProcess } from "./ui.js";

/* The property that makes every other property here safe to have: a PIPE gets the marker stream and nothing
 * else. The desktop app parses those markers into a progress bar (desktop-app/src/desktop.ts) and CI reads
 * them out of a log, so `plain` is a wire contract and the redrawing path must be unreachable from it. */

const fake = (over: Partial<UiProcess> & { readonly env?: Record<string, string | undefined> } = {}) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ui = createUi({
        stdout: { write: (chunk: string) => stdout.push(chunk), isTTY: over.stdout?.isTTY, columns: over.stdout?.columns ?? 92 },
        stderr: { write: (chunk: string) => stderr.push(chunk) },
        env: over.env ?? {},
    });
    return { ui, out: () => stdout.join(""), err: () => stderr.join("") };
};

describe("mode detection", () => {
    it("treats anything that is not a terminal as a pipe", () => {
        expect(fake().ui.mode).toBe("plain");
        expect(fake({ stdout: { write: () => {}, isTTY: false } }).ui.mode).toBe("plain");
        expect(fake({ stdout: { write: () => {}, isTTY: true } }).ui.mode).toBe("rich");
    });

    it("lets a parent CLI force the mode it spawned this one for", () => {
        // `ic` sets this when it runs an agent installer inside its own checklist: a second banner and a
        // second plan in the middle of somebody else's install is the seam this exists to remove.
        expect(fake({ stdout: { write: () => {}, isTTY: true }, env: { INTENTIC_UI: "nested" } }).ui.mode).toBe("nested");
        expect(fake({ stdout: { write: () => {}, isTTY: true }, env: { INTENTIC_UI: "plain" } }).ui.mode).toBe("plain");
        expect(fake({ stdout: { write: () => {}, isTTY: true }, env: { INTENTIC_PLAIN: "1" } }).ui.mode).toBe("plain");
        // A value nobody recognises is not a mode: fall back to asking the terminal.
        expect(fake({ stdout: { write: () => {}, isTTY: true }, env: { INTENTIC_UI: "fancy" } }).ui.mode).toBe("rich");
    });
});

describe("the plain contract", () => {
    it("emits the phase marker verbatim and nothing around it", () => {
        const { ui, out } = fake();
        const stepId = "sync-enrol";
        const stepLabel = "enrolling this machine with your sandbox…";
        ui.begin("intentic - setting up sync", [{ phase: "a", label: "A", weight: 1 }]);
        ui.step(stepId, stepLabel);
        ui.detail("swallowed - a pipe never asked for a live readout");
        ui.close();
        expect(out()).toContain(`[${stepId}]`);
        expect(out()).toContain(stepLabel);
        expect(out()).not.toContain("setting up sync");
    });

    it("keeps the row and narration shapes ic has always written", () => {
        const { ui, out, err } = fake();
        ui.row("pass", "Docker");
        ui.row("warn", "Disk space", "12 GiB free");
        ui.row("fail", "Platform reachable");
        ui.row("skip", "Public URL", "no public URL to probe");
        const note = "resolving the Cloudflare zone…";
        ui.note(note);
        const warnFirst = "no reachability grant.";
        const warnRest = "Re-open the setup screen.";
        ui.warn(`${warnFirst}\n${warnRest}`);
        expect(out()).toContain("  ok    Docker");
        expect(out()).toContain("  warn  Disk space, 12 GiB free");
        expect(out()).toContain("  FAIL  Platform reachable");
        expect(out()).toContain("  skip  Public URL, no public URL to probe");
        expect(out()).toContain(note);
        expect(err()).toContain(warnFirst);
        expect(err()).toContain(warnRest);
    });

    it("writes no escape sequence anywhere", () => {
        const { ui, out, err } = fake();
        ui.begin("t", [{ phase: "p", label: "L", weight: 5 }]);
        ui.step("p", "doing it…");
        ui.row("pass", "thing");
        ui.progress("downloaded 3 MB");
        ui.finished("Done.", "https://example.test", "Go back to your browser.", [["stop it", "x stop"]]);
        ui.fail("it broke");
        ui.close();
        // A substring search rather than a regex: matching a control character in a pattern is itself a lint
        // error (no-control-regex), and the assertion here is about the ABSENCE of the byte, not its shape.
        const ESC = "\u001b";
        expect(out()).not.toContain(ESC);
        expect(err()).not.toContain(ESC);
    });
});

describe("nested mode", () => {
    it("contributes detail rather than a second install", () => {
        // No banner, no numbered checklist, no ending block: the parent owns all three.
        const { ui, out } = fake({ stdout: { write: () => {}, isTTY: true }, env: { INTENTIC_UI: "nested", NO_COLOR: "1" } });
        ui.begin("intentic - setting up sync", [{ phase: "p", label: "L", weight: 5 }]);
        ui.step("p", "enrolling this machine…");
        ui.finished("Sync started.", undefined, "ignored here");
        ui.close();
        const lines = out().split("\n").filter(Boolean);
        expect(lines.some((line) => line.includes("setting up sync"))).toBe(false);
        expect(lines.some((line) => line.includes("Enrolling this machine"))).toBe(true);
        expect(lines.some((line) => line.includes("Sync started."))).toBe(true);
        expect(out()).not.toContain("\r");
    });
});

describe("rich mode", () => {
    it("repaints one line and only ever advances the checklist", () => {
        const { ui, out } = fake({ stdout: { write: () => {}, isTTY: true, columns: 92 }, env: { NO_COLOR: "1" } });
        ui.begin("intentic", [
            { phase: "one", label: "First", weight: 10 },
            { phase: "two", label: "Second", weight: 10 },
        ]);
        ui.step("one", "the first thing…");
        ui.step("two", "the second thing…");
        // A phase already passed is narration, not a step: the cursor never goes backwards.
        ui.step("one", "the first thing again…");
        ui.close();
        const text = out();
        expect(text).toContain("2 steps, roughly 1 minute.");
        expect(text).toContain("First");
        expect(text).toContain("Second");
        // Three announcements, three ordinals: the ordinal counts what happened, the plan only labels it.
        expect(text).toContain(" 3  The first thing again");
        // Every repaint returns to column one rather than scrolling.
        expect(text).toContain("\r");
    });

    it("never lets the repainted line reach the last column", () => {
        const columns = 60;
        const { ui, out } = fake({ stdout: { write: () => {}, isTTY: true, columns }, env: { NO_COLOR: "1" } });
        ui.begin("intentic", [{ phase: "p", label: "A step with a fairly long label on it", weight: 30 }]);
        ui.step("p", "…");
        ui.detail("and a detail that would comfortably run off the end of any narrow terminal");
        ui.close();
        // One character over and the terminal wraps it, after which every carriage return lands a row late.
        for (const frame of out().split("\r")) {
            expect([...frame.split("\n")[0]!].length).toBeLessThanOrEqual(columns);
        }
    });

    it("ranks the ending: one address, one instruction, then footnotes", () => {
        const { ui, out } = fake({ stdout: { write: () => {}, isTTY: true }, env: { NO_COLOR: "1" } });
        ui.finished("Sync is running.", "https://sandbox-abc.example.dev", "Go back to your browser.", [
            ["stop it", "intentic-sync stop"],
            ["its logs", "intentic-sync logs"],
        ]);
        const lines = out().split("\n");
        const address = lines.findIndex((line) => line.includes("sandbox-abc"));
        const instruction = lines.findIndex((line) => line.includes("Go back to your browser."));
        const footnote = lines.findIndex((line) => line.includes("intentic-sync stop"));
        expect(address).toBeGreaterThan(0);
        expect(instruction).toBeGreaterThan(address);
        expect(footnote).toBeGreaterThan(instruction);
        // The footnote block is labelled once and its columns align.
        expect(lines[footnote]).toContain("later");
        expect(lines[footnote + 1]).toContain("its logs");
    });
});

describe("wrapping", () => {
    it("keeps every word and stays inside the width", () => {
        const text = "the sync transport is not listening on this port yet, so syncing starts as soon as it is";
        for (const width of [20, 33, 48, 90]) {
            const lines = wrap(text, width);
            expect(lines.every((line) => [...line].length <= width)).toBe(true);
            expect(lines.join(" ")).toBe(text);
        }
    });

    it("leaves an unbreakable token whole", () => {
        // A URL is there to be copied; breaking one to protect a margin makes it useless.
        const url = "https://sandbox-3c469e9d6c58.intentic.dev/some/deep/path";
        expect(wrap(url, 30)).toEqual([url]);
        // A width too narrow to lay anything out is handed back untouched rather than shredded.
        expect(wrap("a b c", 5)).toEqual(["a b c"]);
        expect(wrap("", 40)).toEqual([""]);
    });

    it("truncates only inside its budget", () => {
        expect(truncate("hello", 10)).toBe("hello");
        expect(truncate("hello", 5)).toBe("hello");
        expect([...truncate("hello", 4)]).toHaveLength(4);
        expect(truncate("hello", 1)).toBe("");
        expect([...truncate("★★★★★", 3)]).toHaveLength(3);
    });
});

describe("durations and estimates", () => {
    it("reads durations as a person would say them", () => {
        expect(humanDuration(400)).toBe("0.4s");
        expect(humanDuration(9_000)).toBe("9.0s");
        expect(humanDuration(42_000)).toBe("42s");
        expect(humanDuration(89_000)).toBe("89s");
        expect(humanDuration(90_000)).toBe("2m");
        expect(humanDuration(291_000)).toBe("5m");
    });

    it("holds the estimate still rather than letting it swing", () => {
        expect(estimate(400, 200, 100)).toBe("2m");
        // A machine three times slower than the plan expects is quoted at the 3x clamp, so one stalled step
        // cannot turn a two-minute install into an hour on screen. The same floor applies in reverse.
        expect(estimate(400, 100, 6000)).toBe("15m");
        expect(estimate(400, 100, 1)).toBe("3m");
    });

    it("stays quiet when it would be noise", () => {
        expect(estimate(400, 0, 10)).toBeUndefined();
        expect(estimate(0, 50, 10)).toBeUndefined();
        expect(estimate(100, 95, 95)).toBeUndefined();
    });
});

describe("labels", () => {
    it("turns a step's own sentence into a label when no plan carries one", () => {
        expect(asLabel("enrolling this machine with your sandbox…")).toBe("Enrolling this machine with your sandbox");
        expect(asLabel("starting sync…")).toBe("Starting sync");
        expect(asLabel("")).toBe("");
    });
});
