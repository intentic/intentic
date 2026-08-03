import { afterEach, describe, expect, it, vi } from "vitest";
import { enrollKey, selectPairings } from "./commands.js";
import type { Pairing, SyncState } from "./config.js";

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

/* Which sandbox a command acts on. With a fleet on one machine, `pause`/`resume`/`uninstall` need to name one —
 * and a real id is `sandbox-<hex>-<zone>`-shaped, so a human names it by the fragment they recognize. An ambiguous
 * or unknown fragment must refuse rather than guess: guessing here unpairs the wrong sandbox. */
describe("selectPairings", () => {
    const pairing = (sandboxId: string): Pairing => ({
        sandboxUrl: `https://${sandboxId}/`,
        sandboxId,
        sshHostname: `ssh-${sandboxId}`,
        mode: "sync",
    });
    const state: SyncState = {
        pairings: [pairing("sandbox-0738cd6b5027-intentic-dev"), pairing("sandbox-bce57bb9fe3b-intentic-dev")],
    };

    it("selects every pairing when no sandbox is named", () => {
        expect(selectPairings(state, undefined)).toEqual(state.pairings);
    });

    it("selects by full sandbox id", () => {
        expect(selectPairings(state, "sandbox-bce57bb9fe3b-intentic-dev")).toEqual([state.pairings[1]]);
    });

    it("selects by the fragment a human would type", () => {
        expect(selectPairings(state, "0738")).toEqual([state.pairings[0]]);
    });

    it("refuses an ambiguous fragment instead of picking one", () => {
        expect(() => selectPairings(state, "intentic-dev")).toThrow(/matches more than one/);
    });

    it("refuses an unknown fragment, listing what this machine does pair", () => {
        expect(() => selectPairings(state, "nope")).toThrow(/no paired sandbox matches "nope".*0738cd6b5027/s);
    });
});
