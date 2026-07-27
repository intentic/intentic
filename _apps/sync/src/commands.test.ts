import { afterEach, describe, expect, it, vi } from "vitest";
import { cliLauncher, enrollKey } from "./commands.js";

const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
    vi.restoreAllMocks();
});

describe("enrollKey", () => {
    it("retries through transient tunnel-warmup 502s, then returns the ssh hostname + token + granted mode", async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
            .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
            .mockResolvedValueOnce(jsonResponse(200, { ok: true, sshHostname: "ssh-abc.example.dev", syncToken: "ist_tok", mode: "mirror" }));
        vi.stubGlobal("fetch", fetchMock);

        const enrolled = await enrollKey("https://sandbox-abc.example.dev/", "pair-token", "ssh-ed25519 AAAA", { delayMs: 0 });

        expect(enrolled).toEqual({ sshHostname: "ssh-abc.example.dev", syncToken: "ist_tok", mode: "mirror" });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("retries when fetch throws, and defaults mode to sync for a daemon that omits it (predates modes)", async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"))
            .mockResolvedValueOnce(jsonResponse(200, { sshHostname: "ssh-abc.example.dev" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(enrollKey("https://sandbox-abc.example.dev", "pair", "key", { delayMs: 0 })).resolves.toEqual({
            sshHostname: "ssh-abc.example.dev",
            mode: "sync",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("fails fast on 401 without retrying", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("nope", { status: 401 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(enrollKey("https://sandbox-abc.example.dev", "pair", "key", { delayMs: 0 })).rejects.toThrow(/pairing expired/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws the same 502 message when warmup never resolves", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad gateway", { status: 502 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(enrollKey("https://sandbox-abc.example.dev", "pair", "key", { attempts: 3, delayMs: 0 })).rejects.toThrow(
            /enrolling the sync key failed \(502\)/,
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});

// How the CLI re-invokes itself decides whether the mirror watcher ever runs, and the two install shapes need
// opposite argv. The released install is a `bun build --compile` binary whose process.argv[1] is a path inside
// its own virtual filesystem; the runtime re-injects that entry on every launch, so passing it again shifted the
// real command to argv[2] and every watcher died with "No command registered for `/$bunfs/root/…`" — mirroring
// silently never started on any released build. A plain `node dist/cli.js` run still needs the script path.
describe("cliLauncher", () => {
    const withEntry = <T>(entry: string | undefined, run: () => T): T => {
        const argv = process.argv;
        process.argv = entry === undefined ? [process.execPath] : [process.execPath, entry];
        try {
            return run();
        } finally {
            process.argv = argv;
        }
    };

    it("passes the script path for a plain node invocation", () => {
        expect(withEntry("/opt/intentic/sync/dist/cli.js", cliLauncher)).toEqual([process.execPath, "/opt/intentic/sync/dist/cli.js"]);
    });

    it("omits the virtual entry for a bun-compiled binary", () => {
        expect(withEntry("/$bunfs/root/intentic-sync-linux-amd64", cliLauncher)).toEqual([process.execPath]);
    });

    it("omits the virtual entry on Windows, where bun roots it elsewhere", () => {
        expect(withEntry("B:\\~BUN\\root\\intentic-sync-windows-amd64.exe", cliLauncher)).toEqual([process.execPath]);
    });

    it("refuses to guess when there is no entry at all", () => {
        expect(() => withEntry(undefined, cliLauncher)).toThrow(/cannot locate/);
    });
});
