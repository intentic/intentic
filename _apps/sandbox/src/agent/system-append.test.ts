import { expect, test } from "vitest";
import { systemAppendOf } from "./system-append.js";

/* The suffix's ORDER is what these pin. Every piece is stable across a session so the provider's prompt cache
 * survives it; that only holds if the piece a user actually edits sits at the very end, where an edit can
 * invalidate the tail instead of the whole cached prefix. */

const NOTE = "## Delegating\nUse codex exec.";
const INSTRUCTIONS = "Answer in Polish.";

test("nothing to append is undefined, not an empty string", () => {
    // The runner spreads the result into the SDK options; "" would hang a trailing separator off the preset
    // prompt for no reason.
    expect(systemAppendOf({ terseOutput: false, customInstructions: "", external: false })).toBeUndefined();
});

test("the owner's instructions come last, after everything the daemon composes", () => {
    const append = systemAppendOf({ note: NOTE, terseOutput: true, customInstructions: INSTRUCTIONS, external: false });
    expect(append?.startsWith(NOTE)).toBe(true);
    expect(append?.endsWith(INSTRUCTIONS)).toBe(true);
    expect(append).toContain("be concise");
    // Dropping the delegation note (stableSystemPrompt moved it into the user message) must not reorder the
    // rest — the cached prefix is byte-compared, so a swap here is a silent cache miss on every turn.
    expect(systemAppendOf({ terseOutput: true, customInstructions: INSTRUCTIONS, external: false })?.endsWith(INSTRUCTIONS)).toBe(true);
});

test("a turn answering someone outside the sandbox is withheld the owner's instructions", () => {
    // A web-chat visitor's reply must not carry "call me by my first name, be blunt, answer in Polish": those
    // are how the agent talks to the OWNER. The automation's own prompt steers an external wake instead.
    const external = systemAppendOf({ terseOutput: true, customInstructions: INSTRUCTIONS, external: true });
    expect(external).not.toContain(INSTRUCTIONS);
    // Everything else still applies — terseness is about the agent, not about who is reading.
    expect(external).toContain("be concise");
});

test("empty instructions append nothing at all, not a blank line", () => {
    expect(systemAppendOf({ note: NOTE, terseOutput: false, customInstructions: "", external: false })).toBe(NOTE);
});
