import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { controlTokenSeedScript, controlTokenStore } from "./parse.js";
import { encodeCommand } from "./run.js";

// Pins two encodings that fail silently when wrong: a mis-encoded script returns empty output, a mis-shaped token store
// authorizes nobody.

test("a script reaches PowerShell as UTF-16LE base64, so quoting is not a thing on the way in", () => {
    const script = `Write-Output "it's \`"quoted\`" & piped | oddly"`;
    expect(Buffer.from(encodeCommand(script), `base64`).toString(`utf16le`)).toBe(script);
});

test("a non-ASCII script survives the encoding", () => {
    const script = `Write-Output 'Intentic, Setting up your sandbox'`;
    expect(Buffer.from(encodeCommand(script), `base64`).toString(`utf16le`)).toBe(script);
});

test("the seeded control-token store is the shape the daemon reads", () => {
    const store: unknown = JSON.parse(controlTokenStore(`deadbeef`));
    expect(store).toEqual({
        tokens: [{ id: `windows-smoke`, label: `windows smoke`, scope: `drive`, hash: `deadbeef`, createdAt: 0 }],
    });
});

test("the seeded scope is drive, and stays short of landing anything", () => {
    expect(controlTokenStore(`deadbeef`)).toContain(`"scope":"drive"`);
    expect(controlTokenStore(`deadbeef`)).not.toContain(`"scope":"land"`);
});

// Built from the constants, not hardcoded, so a future rename doesn't need updating here too.
const STORE = `${WORKSPACE_ROOT}/${STATE_DIR}/identity/control-tokens.json`;

test("the seed creates the directory of the file it writes, however deep the daemon moves the store", () => {
    const script = controlTokenSeedScript(`${WORKSPACE_ROOT}/${STATE_DIR}/identity/deeper/control-tokens.json`, controlTokenStore(`deadbeef`));
    expect(script).toContain(`mkdir -p ${WORKSPACE_ROOT}/${STATE_DIR}/identity/deeper`);
    expect(script.indexOf(`mkdir -p`)).toBeLessThan(script.indexOf(`cat >`));
});

test("the store reaches the file byte for byte, with nothing in it expanded", () => {
    // Unquoted heredoc would let the shell expand a `$` or backtick a label might carry.
    expect(controlTokenSeedScript(STORE, controlTokenStore(`deadbeef`))).toContain(`<<'STORE'\n${controlTokenStore(`deadbeef`)}\nSTORE`);
});
