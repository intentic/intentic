import { expect, test } from "vitest";
import { plainText } from "./plain-text.js";

// Built from their code points rather than pasted in: a control byte in a source file is invisible to whoever
// reads this next, and which sequence a case is about is the whole of the case.
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const BACKSPACE = String.fromCodePoint(0x08);

// The failure this exists for: a runner's tail quoted straight into a fix prompt, where every colour switch
// arrived as literal `[2m` litter around the one line that says what broke.
test("a runner's colour codes leave the sentence they were wrapped around", () => {
    const captured = `@intentic/sandbox:test: ${ESC}[32mPASS${ESC}[39m ${ESC}[2m10 tests${ESC}[22m${ESC}[39m`;
    expect(plainText(captured)).toBe("@intentic/sandbox:test: PASS 10 tests");
});

test("a title set or a hyperlink — OSC, ended either way — goes with them", () => {
    expect(plainText(`${ESC}]0;pnpm test${BEL}done`)).toBe("done");
    expect(plainText(`${ESC}]8;;https://ci.example/run/7${ESC}\\run 7${ESC}]8;;${ESC}\\`)).toBe("run 7");
});

// A spinner rewrites one line: only the last frame was ever on screen, so only it is evidence.
test("a progress line collapses to the frame that was left showing", () => {
    expect(plainText("Progress: 1/3\rProgress: 2/3\rProgress: 3/3\ndone")).toBe("Progress: 3/3\ndone");
});

// CRLF, and a writer parking the cursor at the end of a line, are not erases — an empty frame must not win.
test("a trailing carriage return keeps the line it was on", () => {
    expect(plainText("built in 4s\r\nnext line")).toBe("built in 4s\nnext line");
});

test("what is left of a control byte once the escapes are gone is nothing", () => {
    expect(plainText(`bell${BEL} backspace${BACKSPACE} stray${ESC} esc`)).toBe("bell backspace stray esc");
});

// Tabs and newlines are how a runner's table and a stack trace read at all.
test("text a terminal would have printed as text is untouched", () => {
    const log = "FAIL\tsrc/a.test.ts\n  at foo (/w/a.ts:3:1)\n\n1 failed | 2 passed\n";
    expect(plainText(log)).toBe(log);
});
