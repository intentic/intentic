import { expect, test } from "bun:test";
import { cleanToolText } from "./cleaners.mjs";

test("generic tool cleaning keeps both ends and an error from the omitted middle", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `entry ${i}`);
    lines[250] = "fatal error: cannot connect";
    const out = cleanToolText(lines.join("\n"));
    expect(out).toContain("entry 0\n");
    expect(out).toContain("entry 499");
    expect(out).toContain("fatal error: cannot connect");
    // The error keeps one line of context either side (output-cap.mjs priorityCap); the rest of the middle goes.
    expect(out).toContain("entry 249\nfatal error: cannot connect\nentry 251");
    expect(out).not.toContain("entry 240\n");
});

test("wide and repeated runs share the shell cleaner semantics", () => {
    const out = cleanToolText(Array.from({ length: 300 }, () => "same diagnostic").join("\n"));
    expect(out.split("\n").length).toBeLessThan(10);
    expect(out).toContain("same diagnostic");
    expect(cleanToolText("x".repeat(90_000)).length).toBeLessThanOrEqual(12_050);
});

test("the generic stages honor the cleaner selection", () => {
    const raw = Array.from({ length: 300 }, () => "repeated text").join("\n");
    expect(cleanToolText(raw, { enabled: new Set() })).toBe(raw);
});
