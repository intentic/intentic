import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { controlTokenSeedScript, controlTokenStore } from "./parse.js";
import { encodeCommand } from "./run.js";

/* Two encodings, both of which fail SILENTLY when they are wrong: a mis-encoded script runs and returns the
 * empty string, and a mis-shaped token store parses and simply authorizes nobody. Neither produces an error
 * anyone would see, so both are worth pinning. */

test("a script reaches PowerShell as UTF-16LE base64, so quoting is not a thing on the way in", () => {
    // The round trip is the assertion: whatever is written here is exactly what -EncodedCommand decodes to,
    // however many quotes it carries.
    const script = `Write-Output "it's \`"quoted\`" & piped | oddly"`;
    expect(Buffer.from(encodeCommand(script), `base64`).toString(`utf16le`)).toBe(script);
});

test("a non-ASCII script survives the encoding", () => {
    const script = `Write-Output 'Intentic, Setting up your sandbox'`;
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
    // one: the whole reason the ladder has separate rungs is that "a program that works, a person who decides"
    // is the arrangement worth defaulting to.
    expect(controlTokenStore(`deadbeef`)).toContain(`"scope":"drive"`);
    expect(controlTokenStore(`deadbeef`)).not.toContain(`"scope":"land"`);
});

// Wherever the daemon keeps its identity files today. Named through the constants for the same reason the
// tier is: the point of these two tests is that nothing has to be renamed twice when it moves again.
const STORE = `${WORKSPACE_ROOT}/${STATE_DIR}/identity/control-tokens.json`;

test("the seed creates the directory of the file it writes, however deep the daemon moves the store", () => {
    /* The regression these tests exist for. `sh` will not create a file in a directory that is not there, and
     * these files have already moved once, so what is asserted is not the spelling of today's directory, it
     * is that the mkdir and the redirect agree, for any path at all. */
    const script = controlTokenSeedScript(`${WORKSPACE_ROOT}/${STATE_DIR}/identity/deeper/control-tokens.json`, controlTokenStore(`deadbeef`));
    expect(script).toContain(`mkdir -p ${WORKSPACE_ROOT}/${STATE_DIR}/identity/deeper`);
    expect(script.indexOf(`mkdir -p`)).toBeLessThan(script.indexOf(`cat >`));
});

test("the store reaches the file byte for byte, with nothing in it expanded", () => {
    // A quoted heredoc: the JSON carries `$` and backticks the day a label does, and an unquoted delimiter
    // would let the container's shell rewrite the credential store on its way to disk.
    expect(controlTokenSeedScript(STORE, controlTokenStore(`deadbeef`))).toContain(`<<'STORE'\n${controlTokenStore(`deadbeef`)}\nSTORE`);
});
