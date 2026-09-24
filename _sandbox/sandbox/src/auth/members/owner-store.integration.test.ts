import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileOwnerStore } from "../auth.js";

// The owner file decides who may drive the sandbox, and "no owner" is what lets the next signed-in identity bind as
// owner; an owner file that is there but unreadable must therefore never read as absent, nor be written over.

const ownerPath = (): string => join(mkdtempSync(join(tmpdir(), "owner-store-")), "owner.json");

test("a sandbox nobody has claimed reads as no owner, and the first write is read back", async () => {
    const path = ownerPath();
    const owner = fileOwnerStore(path);
    expect(await owner.read()).toBeUndefined();
    await owner.write("ada@example.com");
    expect(await owner.read()).toBe("ada@example.com");
});

test("an owner file that cannot be read refuses both the read and a new claim, and stays as it was", async () => {
    const path = ownerPath();
    await writeFile(path, `{"email": "ada@example.com"`, "utf8");
    const owner = fileOwnerStore(path);
    await expect(owner.read()).rejects.toThrow("the sandbox owner file could not be read (the file is not valid JSON)");
    await expect(owner.write("mallory@example.com")).rejects.toThrow("owner.json could not be read by this build");
    expect(await readFile(path, "utf8")).toBe(`{"email": "ada@example.com"`);
});
