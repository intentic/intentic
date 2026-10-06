import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as childProcessOriginal from "node:child_process";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";

// A release asset is unpacked by the daemon, which runs as root, so tar would hand every member the uid and gid the
// archive recorded unless told not to. Pins the flag on the command itself: the ownership it prevents is only visible
// to a root test run, which CI does not promise.

const calls: { readonly file: string; readonly args: readonly string[] }[] = [];

// Defines `promisify.custom` like the real execFile, so the install's promisified call is the one recorded.
jest.mock("node:child_process", async () => {
    const execFile = (file: string, args: readonly string[], done: (error: Error | null, stdout: string, stderr: string) => void): void => {
        calls.push({ file, args });
        done(null, "", "");
    };
    return {
        ...childProcessOriginal,
        execFile: Object.assign(execFile, {
            [promisify.custom]: async (file: string, args: readonly string[]) => {
                calls.push({ file, args });
                return { stdout: "", stderr: "" };
            },
        }),
    };
});

const { releaseInstall } = await import("./engine-install.js");
const { engineDescriptor } = await import("./engine-descriptors.js");

let prefix = "";

beforeEach(async () => {
    prefix = await mkdtemp(join(tmpdir(), "engine-install-"));
    calls.length = 0;
    stubGlobal("fetch", async () => new Response(new Uint8Array([0x1f, 0x8b])));
});

afterEach(async () => {
    unstubAllGlobals();
    await rm(prefix, { recursive: true, force: true });
});

test("a release asset unpacks as the daemon's own files, never as the archive's recorded owners", async () => {
    // Nothing was really unpacked, so the install ends at looking for its binary; the command it ran is the point.
    await expect(releaseInstall(engineDescriptor("translator"), "6.0.0", prefix)).rejects.toThrow(/contains no cli-proxy-api/);
    expect(calls).toEqual([
        { file: "tar", args: ["-xzf", join(prefix, "asset.tar.gz"), "--no-same-owner", "-C", join(prefix, ".unpack")] },
    ]);
});
