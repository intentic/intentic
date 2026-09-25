import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { accountFiles } from "./account-files.js";

// The directory every provider credential store sits on, shared with what else it keeps there (a catalog cache).

const AccountSchema = z.object({ id: z.string().min(1), key: z.string().min(1), connectedAt: z.number() });

const scratch = (): string => mkdtempSync(join(tmpdir(), "account-files-"));

test("an account round-trips through its own file, written owner-only as indented JSON", async () => {
    const dir = scratch();
    const files = accountFiles(dir, AccountSchema);
    await files.write({ id: "a1", key: "secret", connectedAt: 1 });

    expect(await files.read("a1")).toEqual({ id: "a1", key: "secret", connectedAt: 1 });
    expect(readFileSync(join(dir, "a1.json"), "utf8")).toBe(`${JSON.stringify({ id: "a1", key: "secret", connectedAt: 1 }, undefined, 2)}\n`);
    expect(statSync(join(dir, "a1.json")).mode & 0o777).toBe(0o600);
});

test("the list holds only files of the account's shape, oldest connection first", async () => {
    const dir = scratch();
    const files = accountFiles(dir, AccountSchema);
    await files.write({ id: "late", key: "k", connectedAt: 20 });
    await files.write({ id: "early", key: "k", connectedAt: 10 });
    writeFileSync(join(dir, "models.json"), JSON.stringify([{ id: "a-model", label: "A model" }]));
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "notes.txt"), "not an account");

    expect((await files.list()).map((account) => account.id)).toEqual(["early", "late"]);
    expect(await files.read("models")).toBeUndefined();
    expect(await files.read("broken")).toBeUndefined();
});

test("a directory never written reads as no accounts at all", async () => {
    const files = accountFiles(join(scratch(), "never-created"), AccountSchema);

    expect(await files.list()).toEqual([]);
    expect(await files.read("a1")).toBeUndefined();
});

// Signed out is only a missing file: a credential the daemon cannot read must not show as never connected.
test("an account file that cannot be read is an error, not an absent account", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "a1.json"));
    const files = accountFiles(dir, AccountSchema);

    await expect(files.read("a1")).rejects.toThrow("EISDIR");
    await expect(files.list()).rejects.toThrow("EISDIR");
});

test("removing an account leaves the others, and removing one already gone is no error", async () => {
    const files = accountFiles(scratch(), AccountSchema);
    await files.write({ id: "a", key: "k", connectedAt: 1 });
    await files.write({ id: "b", key: "k", connectedAt: 2 });

    await files.remove("a");
    await files.remove("a");

    expect((await files.list()).map((account) => account.id)).toEqual(["b"]);
});
