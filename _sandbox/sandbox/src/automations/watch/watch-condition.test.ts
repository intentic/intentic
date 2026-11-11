import { failureGist, headAndTail } from "./watch-condition.js";

// What a Node guard prints when its script cannot load: the message sits near the top, under the loader frame, and the
// stack fills the bottom.
const crash = [
    "node:internal/modules/cjs/loader:1228",
    "  throw err;",
    "  ^",
    "",
    "Error: Cannot find module './checks/gmail-from-sender.mjs'",
    ...Array.from({ length: 40 }, (_, index) => `    at Module._resolveFilename (node:internal/modules/cjs/loader:${1100 + index}:27)`),
].join("\n");

test("a long failure keeps its opening lines and its end, saying what was left out", () => {
    const kept = headAndTail(crash);
    expect(kept).toContain("Error: Cannot find module './checks/gmail-from-sender.mjs'");
    expect(kept.endsWith("loader:1139:27)")).toBe(true);
    expect(kept).toMatch(/\n… \d+ characters left out …\n/);
    expect(kept.length).toBeLessThan(crash.length);
});

test("a short failure is kept whole", () => {
    expect(headAndTail("no new mail yet")).toBe("no new mail yet");
});

test("the one-line state names the error rather than the loader frame above it", () => {
    expect(failureGist(headAndTail(crash))).toBe("Error: Cannot find module './checks/gmail-from-sender.mjs'");
    expect(failureGist("still waiting for 1.4.3\nlatest is 1.4.2")).toBe("still waiting for 1.4.3");
});
