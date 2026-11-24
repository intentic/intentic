import { WORKSPACE_ROOT } from "@intentic/constants";
import type { SyncChanges } from "@intentic/sandbox-contract/schemas/devices";
import type { Pairing } from "../config.js";
import { flushTargets, followedSandboxes } from "./change-follow.js";
import { passListing, type LiveSession } from "../mutagen.js";
import { type ChangesAnswer, createFlusher, fetchSyncChanges, type FollowSeams, followSyncChanges, movedSince, retryDelayMs } from "./sync-changes.js";

const settle = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms));

// A flush that takes `ms` and counts how many ran and how many ran at once.
const countedFlush = (ms: number) => {
    const seen = { started: 0, inFlight: 0, most: 0 };
    return {
        seen,
        flush: async (): Promise<void> => {
            seen.started += 1;
            seen.inFlight += 1;
            seen.most = Math.max(seen.most, seen.inFlight);
            await settle(ms);
            seen.inFlight -= 1;
        },
    };
};

describe("createFlusher", () => {
    it("turns a burst of signals into one flush, after the debounce", async () => {
        const { seen, flush } = countedFlush(1);
        const flusher = createFlusher(flush, { debounceMs: 20, minGapMs: 0 });
        for (let index = 0; index < 50; index += 1) {
            flusher.request();
        }
        expect(seen.started).toBe(0);
        await settle(60);
        expect(seen.started).toBe(1);
        flusher.stop();
    });

    it("runs one flush at a time, and once more after it for everything asked meanwhile", async () => {
        const { seen, flush } = countedFlush(60);
        const flusher = createFlusher(flush, { debounceMs: 1, minGapMs: 0 });
        flusher.request();
        await settle(15);
        expect(seen.inFlight).toBe(1);
        flusher.request();
        flusher.request();
        flusher.request();
        await settle(200);
        expect(seen).toEqual({ started: 2, inFlight: 0, most: 1 });
        flusher.stop();
    });

    it("spaces flushes by the gap, so a file written without pause costs no more than the old scan", async () => {
        const starts: number[] = [];
        const flusher = createFlusher(
            async () => {
                starts.push(Date.now());
            },
            { debounceMs: 1, minGapMs: 80 },
        );
        flusher.request();
        await settle(10);
        flusher.request();
        await settle(40);
        expect(starts).toHaveLength(1);
        await settle(80);
        expect(starts).toHaveLength(2);
        expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(75);
        flusher.stop();
    });

    it("says a failed flush and keeps going", async () => {
        const lines: string[] = [];
        let calls = 0;
        const flusher = createFlusher(
            async () => {
                calls += 1;
                throw new Error("no such session");
            },
            { debounceMs: 1, minGapMs: 0 },
            (line) => lines.push(line),
        );
        flusher.request();
        await settle(20);
        flusher.request();
        await settle(20);
        expect(calls).toBe(2);
        expect(lines[0]).toContain("no such session");
        flusher.stop();
    });

    it("runs nothing once stopped", async () => {
        const { seen, flush } = countedFlush(1);
        const flusher = createFlusher(flush, { debounceMs: 10, minGapMs: 0 });
        flusher.request();
        flusher.stop();
        await settle(30);
        expect(seen.started).toBe(0);
    });
});

describe("fetchSyncChanges", () => {
    const answering = (status: number, body: unknown = {}) => jest.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(new Response(JSON.stringify(body), { status }));

    it("asks with the generation and epoch it last saw, on the sync token", async () => {
        const fetchImpl = answering(200, { epoch: "run", generation: 4 });
        const answer = await fetchSyncChanges("https://s.example/", "tok", { epoch: "r un", generation: 3 }, new AbortController().signal, fetchImpl);
        expect(answer).toEqual({ kind: "changes", changes: { epoch: "run", generation: 4 } });
        const [url, init] = fetchImpl.mock.calls[0] ?? [];
        expect(url).toBe("https://s.example/system/sync/changes?after=3&epoch=r%20un");
        expect(init?.headers).toEqual({ "x-intentic-sync": "tok" });
    });

    // An older daemon's answer: its sync token reaches no route it never declared (403), or no such route at all (404).
    it.each([403, 404])("reads %i as a sandbox that does not push", async (status) => {
        expect(await fetchSyncChanges("https://s.example", "tok", undefined, new AbortController().signal, answering(status))).toEqual({ kind: "unsupported" });
    });

    it("throws on anything else, which is an outage and records nothing", async () => {
        await expect(fetchSyncChanges("https://s.example", "tok", undefined, new AbortController().signal, answering(502))).rejects.toThrow("502");
        await expect(fetchSyncChanges("https://s.example", "tok", undefined, new AbortController().signal, answering(401))).rejects.toThrow("401");
    });
});

describe("followSyncChanges", () => {
    const changes = (generation: number, epoch = "run"): ChangesAnswer => ({ kind: "changes", changes: { epoch, generation } });

    // Drives the follow through a script of answers; it stops once the script runs out.
    const follow = async (script: readonly (ChangesAnswer | Error)[]) => {
        const abort = new AbortController();
        const supported: boolean[] = [];
        const waits: number[] = [];
        const asked: (SyncChanges | undefined)[] = [];
        const seen = { changed: 0, supported, waits, asked };
        let index = 0;
        const seams: FollowSeams = {
            target: () => ({ base: "https://s.example", syncToken: "tok" }),
            ask: async (_base, _token, last) => {
                seen.asked.push(last);
                const next = script[index];
                index += 1;
                if (next === undefined) {
                    abort.abort();
                    throw new Error("done");
                }
                if (next instanceof Error) {
                    throw next;
                }
                return next;
            },
            changed: () => {
                seen.changed += 1;
            },
            supported: (pushes) => seen.supported.push(pushes),
            wait: async (ms) => {
                seen.waits.push(ms);
            },
        };
        await followSyncChanges(seams, abort.signal);
        return seen;
    };

    it("flushes on the first answer, on every move, and not on a hold that ran out", async () => {
        const seen = await follow([changes(0), changes(0), changes(1), changes(3), changes(3)]);
        expect(seen.changed).toBe(3);
        expect(seen.supported).toEqual([true, true, true, true, true]);
        expect(seen.asked.slice(0, 3)).toEqual([undefined, { epoch: "run", generation: 0 }, { epoch: "run", generation: 0 }]);
    });

    it("reads a daemon restart as a move", async () => {
        const seen = await follow([changes(5, "one"), changes(0, "two")]);
        expect(seen.changed).toBe(2);
    });

    it("after a failed ask, retries on a short ladder and catches up with a flush", async () => {
        const seen = await follow([changes(2), new Error("reset"), new Error("reset"), changes(2)]);
        expect(seen.waits).toEqual([retryDelayMs(1), retryDelayMs(2)]);
        expect(seen.changed).toBe(2);
        // the ask after an outage names no generation: anything missed meanwhile is answered at once
        expect(seen.asked[3]).toBeUndefined();
    });

    it("says an older sandbox does not push, and asks it again only after a long wait", async () => {
        const seen = await follow([{ kind: "unsupported" }, changes(0)]);
        expect(seen.supported).toEqual([false, true]);
        expect(seen.waits).toEqual([10 * 60_000]);
        expect(seen.changed).toBe(1);
    });
});

describe("movedSince and retryDelayMs", () => {
    it("compares within one epoch", () => {
        expect(movedSince(undefined, { epoch: "a", generation: 0 })).toBe(true);
        expect(movedSince({ epoch: "a", generation: 1 }, { epoch: "a", generation: 1 })).toBe(false);
        expect(movedSince({ epoch: "a", generation: 1 }, { epoch: "b", generation: 1 })).toBe(true);
    });

    it("climbs to half a minute", () => {
        expect([1, 2, 3, 6, 20].map(retryDelayMs)).toEqual([1000, 2000, 4000, 30_000, 30_000]);
    });
});

describe("what a change flushes", () => {
    const pairing = (over: Partial<Pairing>): Pairing => ({ sandboxUrl: "https://a.example/", sandboxId: "a", mode: "sync", localDir: "/w/a", syncToken: "tok", ...over });
    // The same pairing without its folder, or without its token: exactOptionalPropertyTypes will not spell either as undefined.
    const folderless = ({ localDir: _dropped, ...rest }: Pairing): Pairing => rest;
    const tokenless = ({ syncToken: _dropped, ...rest }: Pairing): Pairing => rest;

    it("flushes the workspace sessions of the pairings nothing holds, never a mirror-only one", () => {
        const names = flushTargets(
            [pairing({}), folderless(pairing({ mode: "mirror" })), pairing({ remoteDir: `${WORKSPACE_ROOT}/app`, project: true, ownerPausedAt: 1 })],
            Date.now(),
        );
        expect(names).toEqual(["intentic-a"]);
    });

    it("follows each syncing sandbox once, at the base its first pairing is dialled at, and none said to be gone", () => {
        const followed = followedSandboxes([
            { pairing: pairing({}), base: "http://127.0.0.1:1" },
            { pairing: pairing({ remoteDir: `${WORKSPACE_ROOT}/app`, project: true }), base: "http://127.0.0.1:2" },
            { pairing: pairing({ sandboxId: "b", goneSince: 1 }), base: "https://b.example" },
            { pairing: pairing({ sandboxId: "c", mode: "mirror" }), base: "https://c.example" },
            { pairing: tokenless(pairing({ sandboxId: "d" })), base: "https://d.example" },
        ]);
        expect([...followed.keys()]).toEqual(["a"]);
        expect(followed.get("a")?.base).toBe("http://127.0.0.1:1");
        expect(followed.get("a")?.pairings).toHaveLength(2);
    });
});

describe("passListing", () => {
    it("reads once for every reader of a pass, and again once dropped", () => {
        let reads = 0;
        const listing = passListing((): LiveSession[] => {
            reads += 1;
            return [];
        });
        listing.read();
        listing.read();
        expect(reads).toBe(1);
        listing.invalidate();
        listing.read();
        expect(reads).toBe(2);
    });

    it("keeps no listing that did not answer", () => {
        let reads = 0;
        const listing = passListing(() => {
            reads += 1;
            return undefined;
        });
        listing.read();
        listing.read();
        expect(reads).toBe(2);
    });
});
