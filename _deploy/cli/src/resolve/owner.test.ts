import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerFor } from "./resolve.js";

const workspace = async (files: Record<string, unknown>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-owner-"));
    for (const [name, content] of Object.entries(files)) {
        await writeFile(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
    }
    return join(dir, "desired-state.json");
};
const quiet = { mint: true, log: () => {} };

test("resolve keeps the owner id of the artifact it replaces", async () => {
    const out = await workspace({ "desired-state.json": { version: 1, owner: "3f9a1c2b7d4e", resources: {} } });
    expect(await ownerFor(out, quiet)).toBe("3f9a1c2b7d4e");
});

test("with no owner in the artifact, resolve takes the prune baseline's, so an older artifact does not split the intent", async () => {
    const out = await workspace({
        "desired-state.json": { version: 1, resources: {} },
        ".last-applied.json": { version: 1, owner: "aabbccddeeff", resources: {} },
    });
    expect(await ownerFor(out, quiet)).toBe("aabbccddeeff");
});

test("resolve mints a short id when nothing carries one, and the pipeline (no minting) leaves it unset", async () => {
    const out = await workspace({});
    expect(await ownerFor(out, quiet)).toMatch(/^[0-9a-f]{12}$/);
    const logs: string[] = [];
    expect(await ownerFor(out, { mint: false, log: (line) => logs.push(line) })).toBeUndefined();
    expect(logs[0]).toContain("does not mint one");
});

test("an unreadable artifact is logged and the baseline still answers", async () => {
    const logs: string[] = [];
    const out = await workspace({ "desired-state.json": "{ torn", ".last-applied.json": { version: 1, owner: "aabbccddeeff", resources: {} } });
    expect(await ownerFor(out, { mint: true, log: (line) => logs.push(line) })).toBe("aabbccddeeff");
    expect(logs[0]).toContain("could not read the owner id from the artifact");
});
