import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@intentic/connector-runtime";
import { openWhatsAppConnection } from "./client.js";

/* A SESSION THAT COULD NOT BE READ IS NOT AN UNPAIRED ONE. The open wipes whatever it reads as unpaired, and a wiped
 * link comes back only when the owner pairs the phone again. */

const log: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const open = (sessionDir: string) =>
    openWhatsAppConnection({
        capabilityId: "wa-1",
        phoneNumber: "+49 151 0000001",
        sessionDir,
        log,
        onMessage: () => undefined,
        onLoggedOut: () => undefined,
    });

it("refuses to open, and wipes nothing, when the creds file cannot be read", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "wa-session-"));
    // A directory where the file belongs: the read fails with EISDIR, which says nothing about whether it is paired.
    await mkdir(join(sessionDir, "creds.json"));
    await writeFile(join(sessionDir, "app-state-sync-key-1.json"), `{"kept":true}`);

    await expect(open(sessionDir)).rejects.toMatchObject({ code: "EISDIR" });
    expect(await readFile(join(sessionDir, "app-state-sync-key-1.json"), "utf8")).toBe(`{"kept":true}`);
});
