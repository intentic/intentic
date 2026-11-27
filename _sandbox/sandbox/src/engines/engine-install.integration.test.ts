import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
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

const { downloadInstall, installEngine, releaseInstall } = await import("./engine-install.js");
const { engineDescriptor, grokArch, releaseArch } = await import("./engine-descriptors.js");
const { forgetUpstream } = await import("./engine-channel.js");
const { engineDir, installedVersions, readEngineState } = await import("./engine-store.js");

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

// Grok Build ships as one gzipped binary at a URL of its own; the install fetches that very file for this machine's
// architecture and leaves an executable, decompressed, under the binary's own name.
test("a download engine's build is fetched for this machine and unpacked as an executable", async () => {
    const asked: string[] = [];
    const binary = "#!/bin/sh\necho grok 9.9.9\n";
    stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        return new Response(gzipSync(Buffer.from(binary)));
    });
    await downloadInstall(engineDescriptor("grok-build"), "9.9.9", prefix);
    expect(asked).toEqual([`https://x.ai/cli/grok-9.9.9-linux-${grokArch()}.gz`]);
    expect(await readFile(join(prefix, "grok"), "utf8")).toBe(binary);
    expect((await stat(join(prefix, "grok"))).mode & 0o777).toBe(0o755);
});

test("a download engine whose build is missing fails the install rather than leaving an empty binary", async () => {
    stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await expect(downloadInstall(engineDescriptor("grok-build"), "0.0.1", prefix)).rejects.toThrow(/answered 404/);
});

// A translator release recorded in engines.json is installed only as the bytes whose sha256 was recorded beside it.
// Nothing here is really an archive, so a download that passes the check ends at tar (mocked) finding no binary; one
// that fails it must never reach tar at all.
const ASSET = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const OTHER = sha256(new Uint8Array([0x00]));
const untarred = (): { file: string; args: readonly string[] }[] => [
    { file: "tar", args: ["-xzf", join(prefix, "asset.tar.gz"), "--no-same-owner", "-C", join(prefix, ".unpack")] },
];
const assetOf = (version: string): string => `CLIProxyAPI_${version}_linux_${releaseArch()}.tar.gz`;
const refusal = (version: string, expected: string): string =>
    `${assetOf(version)} does not match the sha256 recorded for translator ${version} in engines.json ` +
    `(expected ${expected}, downloaded ${sha256(ASSET)}); refused, and the current copy keeps serving`;
// Where an install that passed the check stops here: tar is mocked, so nothing is unpacked for it to find.
const unpackedNothing = (version: string) => ({ ok: false as const, version, reason: `${assetOf(version)} contains no cli-proxy-api`, quarantined: false });

test("a release asset whose bytes are the ones recorded for it is unpacked", async () => {
    stubGlobal("fetch", async () => new Response(ASSET));
    await expect(releaseInstall(engineDescriptor("translator"), "8.1.3", prefix, sha256(ASSET))).rejects.toThrow(/contains no cli-proxy-api/);
    expect(calls).toEqual(untarred());
});

test("a release asset unlike the hash recorded for it is refused before tar reads a byte of it", async () => {
    stubGlobal("fetch", async () => new Response(ASSET));
    await expect(releaseInstall(engineDescriptor("translator"), "8.1.3", prefix, OTHER)).rejects.toThrow(refusal("8.1.3", OTHER));
    expect(calls).toEqual([]);
});

// The install as the store runs it: the hash comes from the blessed list, and only for the version that list blesses.
describe("installing a release engine against the blessed list", () => {
    const LIST = "https://example.test/engines.json";
    const serve = (recorded: Record<string, string>): string[] => {
        const asked: string[] = [];
        stubGlobal("fetch", async (url: string) => {
            asked.push(url);
            return url === LIST ? Response.json({ engines: { translator: { blessed: "8.1.3", sha256: recorded } } }) : new Response(ASSET);
        });
        return asked;
    };

    beforeEach(() => {
        process.env["INTENTIC_ENGINES_DIR"] = prefix;
        process.env["INTENTIC_ENGINES_LIST_URL"] = LIST;
        forgetUpstream();
    });

    afterEach(() => {
        delete process.env["INTENTIC_ENGINES_DIR"];
        delete process.env["INTENTIC_ENGINES_LIST_URL"];
        forgetUpstream();
    });

    test("a blessed version whose download is not the recorded build fails like a failed download, leaving nothing behind", async () => {
        serve({ [releaseArch()]: OTHER });
        expect(await installEngine("translator", "8.1.3")).toEqual({ ok: false, version: "8.1.3", reason: refusal("8.1.3", OTHER), quarantined: false });
        expect(calls).toEqual([]);
        expect(await installedVersions("translator")).toEqual([]);
        expect(await readdir(join(engineDir("translator"), ".staging"))).toEqual([]);
        expect(await readEngineState("translator")).toEqual({ quarantined: [] });
    });

    test("a blessed version is checked against this machine's build's hash, not another architecture's", async () => {
        const asked = serve({ [releaseArch()]: sha256(ASSET), elsewhere: OTHER });
        expect(await installEngine("translator", "8.1.3")).toEqual(unpackedNothing("8.1.3"));
        expect(calls.map((call) => call.file)).toEqual(["tar"]);
        expect(asked).toEqual([LIST, `https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.1.3/${assetOf("8.1.3")}`]);
    });

    // A `latest` or `pinned` channel can name a version the list does not bless; the hash beside 8.1.3 is not its hash.
    test("a version the list does not bless is installed unchecked rather than against another version's hash", async () => {
        serve({ [releaseArch()]: OTHER });
        expect(await installEngine("translator", "8.1.2")).toEqual(unpackedNothing("8.1.2"));
        expect(calls.map((call) => call.file)).toEqual(["tar"]);
    });
});
