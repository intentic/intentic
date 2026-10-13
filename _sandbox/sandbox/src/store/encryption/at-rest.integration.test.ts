import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AT_REST_KEY_FILE_ENV } from "@intentic/sandbox-contract";
import { z } from "zod";
import { accountFiles } from "../../agent/providers/accounts/account-files.js";
import { fileSandboxSecrets } from "../../secrets/sandbox-secrets.js";
import { AT_REST_PREVIOUS_KEY_FILE_ENV, AtRestKeyError, migrateAtRestStores } from "./at-rest.js";

const originalKey = process.env[AT_REST_KEY_FILE_ENV];
const originalPrevious = process.env[AT_REST_PREVIOUS_KEY_FILE_ENV];
afterAll(() => {
    if (originalKey === undefined) {delete process.env[AT_REST_KEY_FILE_ENV];}
    else {process.env[AT_REST_KEY_FILE_ENV] = originalKey;}
    if (originalPrevious === undefined) {delete process.env[AT_REST_PREVIOUS_KEY_FILE_ENV];}
    else {process.env[AT_REST_PREVIOUS_KEY_FILE_ENV] = originalPrevious;}
});

test("plain default, boot migration, authenticated reads, refusal, and rotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-at-rest-"));
    const path = join(dir, "sandbox-secrets.json");
    const first = join(dir, "first.key");
    const second = join(dir, "second.key");
    await writeFile(first, randomBytes(32));
    await writeFile(second, randomBytes(32).toString("hex"));
    delete process.env[AT_REST_KEY_FILE_ENV];
    delete process.env[AT_REST_PREVIOUS_KEY_FILE_ENV];
    const vault = fileSandboxSecrets(path);
    await vault.set("example", "sensitive-value");
    expect(await readFile(path, "utf8")).toContain("sensitive-value");

    process.env[AT_REST_KEY_FILE_ENV] = first;
    await migrateAtRestStores(dir);
    const encrypted = await readFile(path, "utf8");
    expect(encrypted.startsWith("INTENTIC-ENC-v1:")).toBe(true);
    expect(encrypted.includes("sensitive-value")).toBe(false);
    expect(await vault.get("example")).toBe("sensitive-value");
    await vault.set("second", "another-value");
    expect(await readFile(path, "utf8")).not.toBe(encrypted);

    process.env[AT_REST_KEY_FILE_ENV] = second;
    const beforeRefusal = await readFile(path);
    await expect(vault.set("example", "replacement")).rejects.toBeInstanceOf(AtRestKeyError);
    expect(await readFile(path)).toEqual(beforeRefusal);

    process.env[AT_REST_PREVIOUS_KEY_FILE_ENV] = first;
    await migrateAtRestStores(dir);
    delete process.env[AT_REST_PREVIOUS_KEY_FILE_ENV];
    expect(await vault.get("example")).toBe("sensitive-value");
    expect(await vault.get("second")).toBe("another-value");
});

test("provider account files migrate and read under their own purpose key", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentic-account-at-rest-"));
    const dir = join(root, "claude");
    await mkdir(dir);
    const key = join(root, "key");
    await writeFile(key, randomBytes(32).toString("base64"));
    delete process.env[AT_REST_KEY_FILE_ENV];
    const accounts = accountFiles(dir, z.object({ id: z.string(), connectedAt: z.number(), credential: z.string() }));
    await accounts.write({ id: "a", connectedAt: 1, credential: "account-secret" });
    process.env[AT_REST_KEY_FILE_ENV] = key;
    await migrateAtRestStores(root);
    expect((await readFile(join(dir, "a.json"), "utf8")).includes("account-secret")).toBe(false);
    expect(await accounts.read("a")).toEqual({ id: "a", connectedAt: 1, credential: "account-secret" });
});
