import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileOwnerGrants, ownerGrantsDocument } from "./owner-grants.js";

// The file form: a yes outlives the store that heard it (a restart opens a fresh one over the same file), and a file this
// build cannot read is neither read as empty nor written over.

const grantsFile = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "owner-grants-")), ownerGrantsDocument.path);

test("a line allowed with Always outlasts the store that heard it, and so does taking it back", async () => {
    const path = await grantsFile();
    await fileOwnerGrants(path, () => 100).allowCommandPolicy("Deleting build directories under /work is fine.", "ada@acme.dev");

    const afterRestart = fileOwnerGrants(path, () => 200);
    expect(await afterRestart.read()).toEqual({
        commandPolicy: [{ line: "Deleting build directories under /work is fine.", at: 100, by: "ada@acme.dev" }],
        unreadable: false,
    });
    expect(await afterRestart.revokeCommandPolicy("Deleting build directories under /work is fine.")).toBe(true);
    expect((await fileOwnerGrants(path).read()).commandPolicy).toEqual([]);
});

test("the file is the owner's alone to read: written with mode 0600", async () => {
    const path = await grantsFile();
    await fileOwnerGrants(path, () => 1).allowCommandPolicy("First.", undefined);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ commandPolicy: [{ line: "First.", at: 1 }] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("a file this build cannot read grants nothing, says so, and is not written over", async () => {
    const path = await grantsFile();
    await writeFile(path, "{ not json", "utf8");
    const grants = fileOwnerGrants(path, () => 1);

    expect(await grants.read()).toEqual({ commandPolicy: [], unreadable: true });
    await expect(grants.allowCommandPolicy("First.", undefined)).rejects.toThrow("owner-grants.json could not be read");
    expect(await readFile(path, "utf8")).toBe("{ not json");
});
