import { mkdirSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { pino } from "pino";
import { z } from "zod";
import { testConfig } from "../../testing.js";
import { fileOwnerStore, ownerDocument, OwnerUnreadableError } from "../auth.js";
import { createAuthSlice } from "../auth-slice.js";

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
    await expect(owner.read()).rejects.toBeInstanceOf(OwnerUnreadableError);
    await expect(owner.write("mallory@example.com")).rejects.toThrow("owner.json could not be read by this build");
    expect(await readFile(path, "utf8")).toBe(`{"email": "ada@example.com"`);
});

test("an owner file that cannot be read is said once a boot, with the command that moves it aside on the host", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "owner-notice-"));
    const path = join(workspaceRoot, ownerDocument.path);
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, "{", "utf8");
    const LogLine = z.looseObject({ level: z.number(), msg: z.string() });
    const said: z.infer<typeof LogLine>[] = [];
    const logger = pino({ level: "error", base: null, timestamp: false }, { write: (line: string) => void said.push(LogLine.parse(JSON.parse(line))) });

    const slice = createAuthSlice({ ...testConfig, connectToken: "the-connect-token" }, workspaceRoot, logger);
    await expect(slice.ownerEmail()).rejects.toBeInstanceOf(OwnerUnreadableError);
    await expect(slice.ownerEmail()).rejects.toBeInstanceOf(OwnerUnreadableError);

    const remedy = `ic sandbox reset-owner ${sandboxIdFromToken("the-connect-token") ?? "no id"}`;
    expect(said).toEqual([{ level: 50, detail: "the file is not valid JSON", remedy, msg: expect.stringContaining(`\`${remedy}\``) }]);
    // Refusing is all it does: the file stays as it was for the host to set aside.
    expect(await readFile(path, "utf8")).toBe("{");
});
