import { expect, test } from "vitest";
import { controlTokenStore } from "./parse.js";
import { encodeCommand } from "./run.js";

/* Two encodings, both of which fail SILENTLY when they are wrong — a mis-encoded script runs and returns the
 * empty string, and a mis-shaped token store parses and simply authorizes nobody. Neither produces an error
 * anyone would see, so both are worth pinning. */

test("a script reaches PowerShell as UTF-16LE base64, so quoting is not a thing on the way in", () => {
    // The round trip is the assertion: whatever is written here is exactly what -EncodedCommand decodes to,
    // however many quotes it carries.
    const script = `Write-Output "it's \`"quoted\`" & piped | oddly"`;
    expect(Buffer.from(encodeCommand(script), `base64`).toString(`utf16le`)).toBe(script);
});

test("a non-ASCII script survives the encoding", () => {
    const script = `Write-Output 'Intentic — Setting up your sandbox'`;
    expect(Buffer.from(encodeCommand(script), `base64`).toString(`utf16le`)).toBe(script);
});

test("the seeded control-token store is the shape the daemon reads", () => {
    // Keyed off the store's schema in auth/control-tokens.ts: an id, a label, a scope, the sha256 of the raw
    // token (never the token), and a creation time.
    const store: unknown = JSON.parse(controlTokenStore(`deadbeef`));
    expect(store).toEqual({
        tokens: [{ id: `windows-smoke`, label: `windows smoke`, scope: `drive`, hash: `deadbeef`, createdAt: 0 }],
    });
});

test("the seeded scope is drive, and stays short of landing anything", () => {
    // `land` is the rung above, and it merges a worktree into the main tree. A CI tier has no business holding
    // one — the whole reason the ladder has separate rungs is that "a program that works, a person who decides"
    // is the arrangement worth defaulting to.
    expect(controlTokenStore(`deadbeef`)).toContain(`"scope":"drive"`);
    expect(controlTokenStore(`deadbeef`)).not.toContain(`"scope":"land"`);
});
