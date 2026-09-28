import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceSymlinks, symlinkRefusal } from "./symlinks.js";

// What the probe exists for: a Windows PC without Developer Mode refuses every link a portable session carries down,
// and Mutagen tries again on every cycle for as long as the session lives. Everywhere else links are carried as they
// always were, so no device there has its sessions recreated.

// A probe that fails the test if it is asked at all.
const unasked = async (): Promise<string | undefined> => {
    throw new Error("the symlink probe ran on a platform that should never ask it");
};

describe("deviceSymlinks", () => {
    it("carries links without asking on every platform but Windows", async () => {
        expect(await deviceSymlinks("linux", unasked)).toEqual({ mode: "portable" });
        expect(await deviceSymlinks("darwin", unasked)).toEqual({ mode: "portable" });
    });

    it("carries links on a Windows PC that can create them (Developer Mode on, or elevated)", async () => {
        expect(await deviceSymlinks("win32", async () => undefined)).toEqual({ mode: "portable" });
    });

    // The refusal travels with the answer, so the agent's log says why links are missing rather than leaving someone
    // to rediscover it from Mutagen's problem list.
    it("leaves links out on a Windows PC that cannot, and says why", async () => {
        expect(await deviceSymlinks("win32", async () => "EPERM")).toEqual({ mode: "ignore", refusal: "EPERM" });
    });
});

describe("symlinkRefusal", () => {
    let dir = "";
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "machine-symlinks-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    // Linux lets any user create a link, so the real probe has nothing to refuse here.
    it("finds nothing to refuse where links can be created", async () => {
        expect(await symlinkRefusal(dir)).toBeUndefined();
    });

    // It runs in this agent's own folder every time a pairing's sessions are prepared: whatever it made, it removes.
    it("leaves nothing behind in the folder it asked in", async () => {
        await symlinkRefusal(dir);
        expect(await readdir(dir)).toEqual([]);
    });

    it("makes the folder it asks in when it is not there yet", async () => {
        const nested = join(dir, "not", "yet");
        expect(await symlinkRefusal(nested)).toBeUndefined();
        expect(await readdir(nested)).toEqual([]);
    });
});
