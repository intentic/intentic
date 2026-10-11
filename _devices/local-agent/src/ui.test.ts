import { asLabel, createUi, displayWidth, estimate, explain, humanDuration, truncate, unicodeSafe, widthFrom, wrap, type UiProcess } from "./ui.js";

// plain is a wire contract: the desktop app parses its markers into a progress bar and CI reads them from a log, so the
// redrawing path must be unreachable from it.

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
        // `ic` sets this to run an installer inside its own checklist, avoiding a second banner and plan mid-install.
        expect(fake({ stdout: { write: () => {}, isTTY: true }, env: { INTENTIC_UI: "nested" } }).ui.mode).toBe("nested");
        expect(fake({ stdout: { write: () => {}, isTTY: true }, env: { INTENTIC_UI: "plain" } }).ui.mode).toBe("plain");
        expect(fake({ stdout: { write: () => {}, isTTY: true }, env: { INTENTIC_PLAIN: "1" } }).ui.mode).toBe("plain");
        // An unrecognised value isn't a mode: falls back to asking the terminal.
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
        expect(out()).toContain("  warn  Disk space — 12 GiB free");
        expect(out()).toContain("  FAIL  Platform reachable");
        expect(out()).toContain("  skip  Public URL — no public URL to probe");
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
        // A substring search, not a regex: matching a control character in a pattern is itself a lint error.
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

    it("keeps a stop's problem and fix under its headline", () => {
        // The parent only says its child failed; without these two lines the person learns neither why nor what to do.
        // LANG=C: a console that cannot draw the Unicode glyphs, so the marker is the ASCII one.
        const { ui, err } = fake({ stdout: { write: () => {}, isTTY: true }, env: { INTENTIC_UI: "nested", NO_COLOR: "1", LANG: "C" } });
        ui.fail(explain("Desktop sync was not set up.", "the pairing code expired 2 minutes ago.", "copy a fresh command from the card."));
        expect(err().split("\n").filter(Boolean)).toEqual([
            "     x  Desktop sync was not set up.",
            "        problem: the pairing code expired 2 minutes ago.",
            "        fix:     copy a fresh command from the card.",
        ]);
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
            expect(displayWidth(frame.split("\n")[0]!)).toBeLessThanOrEqual(columns - 1);
        }
    });

    it("cuts a long label, a wide one and a multi-line one to the line, counting terminal cells", () => {
        // The label used to be drawn whole and only the detail cut, by code points: a long label, or a short CJK one
        // (two cells a character), wrapped the repainted line, and a newline in it broke the line outright.
        for (const [label, detail] of [
            ["Disconnecting this device from https://swift-otter-4821.sandboxes.intentic.dev and its folder", "asking"],
            ["同步文件夹到沙箱", "正在复制项目文件夹中的所有文件和目录"],
            ["Working", "line one\nline two\tand a tab"],
        ] as const) {
            const columns = 40;
            const { ui, out } = fake({ stdout: { write: () => {}, isTTY: true, columns }, env: { NO_COLOR: "1" } });
            ui.act(label);
            ui.detail(detail);
            ui.progress(detail);
            ui.done("Done.");
            const repaints = out()
                .split("\r")
                .map((frame) => frame.split("\n")[0]!)
                .filter((frame) => frame.startsWith("  ⠋") || frame.startsWith("  ⠙"));
            expect(repaints.length).toBeGreaterThan(0);
            for (const frame of repaints) {
                expect(displayWidth(frame)).toBe(columns - 1);
            }
            // Nothing but the repaints and the settled verdict: no stray line a newline in the text would have made.
            expect(out().split("\n").filter(Boolean)).toHaveLength(1);
        }
    });

    it("draws at the terminal's own width, however narrow, and falls back to COLUMNS then 80", () => {
        expect(widthFrom(30, undefined)).toBe(30);
        expect(widthFrom(30, "200")).toBe(30);
        expect(widthFrom(undefined, "50")).toBe(50);
        expect(widthFrom(undefined, " 64 ")).toBe(64);
        expect(widthFrom(undefined, "wide")).toBe(80);
        expect(widthFrom(undefined, undefined)).toBe(80);
        expect(widthFrom(0, undefined)).toBe(80);
        // Clamped only so a budget cannot reach zero, and so a line stays readable on a very wide one.
        expect(widthFrom(8, undefined)).toBe(20);
        expect(widthFrom(400, undefined)).toBe(120);
        const { ui, out } = fake({ stdout: { write: () => {}, isTTY: true, columns: 30 }, env: { NO_COLOR: "1" } });
        ui.act("Stopping");
        ui.detail("sandbox-40ebeea77f90");
        for (const repaint of out().split("\r").filter((frame) => frame.startsWith("  "))) {
            expect(displayWidth(repaint)).toBe(29);
        }
    });

    it("picks glyphs by what the console can draw, never by colour", () => {
        expect(unicodeSafe({}, "linux")).toBe(true);
        expect(unicodeSafe({ LANG: "en_US.UTF-8" }, "linux")).toBe(true);
        expect(unicodeSafe({ LANG: "C" }, "linux")).toBe(false);
        expect(unicodeSafe({ LC_ALL: "C", LANG: "en_US.UTF-8" }, "linux")).toBe(false);
        expect(unicodeSafe({ LC_CTYPE: "de_DE.utf8", LANG: "C" }, "linux")).toBe(true);
        // An empty variable is unset, as POSIX reads the three: LC_ALL="" defers to LANG.
        expect(unicodeSafe({ LC_ALL: "", LANG: "C" }, "linux")).toBe(false);
        expect(unicodeSafe({ LC_ALL: "", LC_CTYPE: "", LANG: "en_US.UTF-8" }, "linux")).toBe(true);
        expect(unicodeSafe({ LANG: "C" }, "win32")).toBe(true);
        // NO_COLOR on a UTF-8 terminal keeps the Unicode glyphs; a C locale with colour on draws ASCII.
        const plainColour = fake({ stdout: { write: () => {}, isTTY: true, columns: 72 }, env: { NO_COLOR: "1", LANG: "en_US.UTF-8" } });
        plainColour.ui.act("Stopping");
        plainColour.ui.done("Stopped.");
        expect(plainColour.out()).toContain("  ✓  Stopped.");
        const asciiColour = fake({ stdout: { write: () => {}, isTTY: true, columns: 72 }, env: { LANG: "C" } });
        asciiColour.ui.act("Stopping");
        asciiColour.ui.done("Stopped.");
        expect(asciiColour.out()).toContain("\u001b[32m+\u001b[0m  Stopped.");
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

/** What a terminal shows once every repaint has landed: each line is whatever followed its last carriage return. */
const screen = (written: string): string[] => written.split("\n").map((line) => line.split("\r").at(-1) ?? "");

describe("actions and reports", () => {
    // LANG=C draws the ASCII glyphs, which keeps the assertions below in plain characters; colour has no say in it.
    const rich = () => fake({ stdout: { write: () => {}, isTTY: true, columns: 72 }, env: { NO_COLOR: "1", LANG: "C" } });

    it("settles an action's live line into its past-tense verdict", () => {
        const { ui, out } = rich();
        ui.act("Stopping sandbox-x");
        ui.done("Stopped sandbox-x.");
        ui.later([["start it", "ic sandbox start sandbox-x"]]);
        ui.close();
        const settled = screen(out()).filter((line) => line.includes("Stopped sandbox-x."));
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatch(/^ {2}\+ {2}Stopped sandbox-x\.\s+\d+\.\ds$/u);
        expect(out()).toContain("later  start it   ic sandbox start sandbox-x");
    });

    it("narrates an action in a log without repainting", () => {
        const { ui, out } = fake();
        ui.act("Stopping sandbox-x");
        ui.done("Stopped sandbox-x.");
        ui.later([["start it", "ic sandbox start sandbox-x"]]);
        expect(out()).toBe("intentic: stopping sandbox-x…\nintentic: Stopped sandbox-x.\n");
    });

    it("draws a report as one glyph column under its header", () => {
        const { ui, out } = rich();
        ui.report("intentic · sandboxes on this device");
        ui.items([
            { tone: "ok", name: "sandbox-a", meta: "running" },
            { tone: "skip", name: "sandbox-bb", meta: "stopped" },
        ]);
        ui.section("removed, recoverable");
        ui.quiet("Nothing removed.");
        const lines = out().split("\n");
        expect(lines).toContain("  intentic · sandboxes on this device");
        expect(lines).toContain("  +  sandbox-a    running");
        expect(lines).toContain("  -  sandbox-bb   stopped");
        expect(lines).toContain("     removed, recoverable");
        expect(lines).toContain("  -  Nothing removed.");
    });

    it("keeps report rows in the log's word column", () => {
        const { ui, out } = fake();
        ui.report("intentic · sandboxes on this device");
        ui.items([{ tone: "warn", name: "sandbox-a", meta: "not answering" }]);
        ui.fields([["Installed", "yes"]]);
        ui.plain("removed   sandbox-b (6 day(s) left)");
        expect(out()).toBe("  warn  sandbox-a — not answering\nInstalled: yes\nremoved   sandbox-b (6 day(s) left)\n");
    });

    it("prints a plain-only line nowhere on a screen", () => {
        const { ui, out } = rich();
        ui.plain("removed   sandbox-b (6 day(s) left)");
        expect(out()).toBe("");
    });
});

describe("a stopped run", () => {
    it("settles the running step as failed before the stop block", () => {
        const { ui, out, err } = fake({ stdout: { write: () => {}, isTTY: true, columns: 72 }, env: { NO_COLOR: "1", LANG: "C" } });
        ui.begin("intentic · connect this device", [{ phase: "fetch", label: "Download the agent", weight: 5 }]);
        ui.step("fetch", "downloading…");
        ui.fail(explain("The agent could not be downloaded.", "github.com did not answer.", "run the same command again."));
        const settled = screen(out()).find((line) => line.includes("Download the agent"));
        expect(settled).toMatch(/^ {2}x {3}1 {2}Download the agent\s+\d+\.\ds$/u);
        expect(err()).toContain("  x  The agent could not be downloaded.");
        expect(err()).toContain("     problem: github.com did not answer.");
        expect(err()).toContain("     fix:     run the same command again.");
    });

    it("keeps the one-line error a log reader takes the reason from", () => {
        const { ui, err } = fake();
        ui.fail(explain("The agent could not be downloaded.", "github.com did not answer."));
        expect(err().split("\n")[0]).toBe("error: The agent could not be downloaded.");
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
        // Counted in terminal cells, and never cut inside a character or a colour escape.
        expect(truncate("下载镜像文件", 6)).toBe("下载…");
        expect(truncate("😀😀😀", 4)).toBe("😀…");
        expect(truncate("\u001b[2mhello world\u001b[0m", 6)).toBe("\u001b[2mhello…\u001b[0m");
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
        // Whole tenths, half up, in integers, as ui.rs counts them: toFixed on a float said 0.1s for 150 ms and 1.1s
        // for 1050 ms, ui.rs's f32 said 0.2s and 1.0s.
        expect([150, 250, 1050, 9949, 9950].map(humanDuration)).toEqual(["0.2s", "0.3s", "1.1s", "9.9s", "10s"]);
    });

    it("holds the estimate still rather than letting it swing", () => {
        expect(estimate(400, 200, 100)).toBe("2m");
        // A machine three times slower than planned is clamped at 3x, so one stalled step can't turn a two-minute
        // install into an hour; the same floor applies in reverse.
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
