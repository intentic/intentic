import { type Switched, switchedLine, switchedNotice } from "./switched.js";

// The row a turn's switch leaves in the record names the part that changed, and says whether the session went with it.

describe("switchedLine", () => {
    it("names the provider, account or loop a fresh session started on", () => {
        expect(switchedLine({ segment: "provider", provider: "codex", model: "gpt-5-codex", fresh: true })).toBe(
            "Switched to Codex: this message started a fresh session, with the conversation so far carried over.",
        );
        expect(switchedLine({ segment: "account", provider: "claude", account: "Work", fresh: true })).toBe(
            "Switched to the Work account: this message started a fresh session, with the conversation so far carried over.",
        );
        expect(switchedLine({ segment: "loop", provider: "kimi", loop: "Claude Code", fresh: true })).toBe(
            "Switched to running through Claude Code: this message started a fresh session, with the conversation so far carried over.",
        );
    });

    it("says an account it has no name for as another of the provider's, never as the provider it was already on", () => {
        expect(switchedLine({ segment: "account", provider: "claude", fresh: true })).toBe(
            "Switched to another Claude account: this message started a fresh session, with the conversation so far carried over.",
        );
    });

    it("says a model switch kept the session, or that it opened a fresh one where there was none to keep", () => {
        expect(switchedLine({ segment: "model", provider: "claude", model: "claude-sonnet-5", fresh: false })).toBe(
            "Switched to Claude Sonnet 5: same session, so the model re-reads the conversation once.",
        );
        expect(switchedLine({ segment: "model", provider: "claude", model: "claude-sonnet-5", fresh: true })).toBe(
            "Switched to Claude Sonnet 5: this message started a fresh session, with the conversation so far carried over.",
        );
    });
});

describe("switchedNotice", () => {
    it("carries every fact it has, and leaves off the ones it does not", () => {
        const all: Switched = { segment: "account", provider: "claude", model: "claude-opus-5-5", account: "Work", loop: "Claude Code", fresh: true };
        expect(switchedNotice(all)).toStrictEqual({
            code: "switched",
            params: { segment: "account", provider: "claude", model: "claude-opus-5-5", account: "Work", loop: "Claude Code", fresh: true },
        });
        expect(switchedNotice({ segment: "model", provider: "claude", fresh: false })).toStrictEqual({
            code: "switched",
            params: { segment: "model", provider: "claude", fresh: false },
        });
    });
});
