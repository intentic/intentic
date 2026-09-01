import type { SandboxSummary } from "@intentic-app/api-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.mock("../useApi", () => ({ apiClient: { sandbox: { list: vi.fn(), delete: vi.fn(), leave: vi.fn() } } }));
const { apiClient } = await import("../useApi");
const listMock = vi.mocked(apiClient.sandbox.list);
const { queryClient } = await import("../queryPersistence");
const { resetDaemonBoot, setDaemonBoot } = await import("./useDaemonBoot");
const { signalConnection, useSandbox } = await import("./useSandbox");

const summary = (id: string): SandboxSummary => ({
    id,
    name: id,
    image: null,
    daemonUrl: null,
    lastSeenAt: null,
    setupCodeClaimedAt: null,
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    hosted: null,
    token: `token-${id}`,
    role: `owner`,
    providedTunnel: false,
    localHostname: null,
});

// The sandbox list now lives in the shared query cache (useSandbox backs it with fetchQuery + a disabled
// observer). Clear it between tests so each starts from an empty registry; refresh() forces a fetch past
// staleTime so every test drives the mock. list() vs refresh() only differ in staleTime: the mutation
// races below are identical either way, so the tests use refresh() to keep the network deterministic.
beforeEach(() => {
    queryClient.clear();
    vi.resetAllMocks();
});

describe(`sandbox list cache retention`, () => {
    it(`pins the observer-less list entry with an explicit Infinity gcTime`, async () => {
        const sandbox = useSandbox();
        listMock.mockResolvedValue({ sandboxes: [summary(`a`)] });
        await sandbox.refresh();
        // fetchQuery-only: no observer keeps the entry alive, so in the browser anything short of Infinity
        // lets the default 5-minute gc evict it while idle: the cache subscription then resets the mirror
        // to [] and every daemon call fails with "isn't reachable yet" until a reload. The eviction itself
        // can't be exercised here (TanStack's node default is already Infinity), so assert the explicit
        // option that protects the browser.
        expect(queryClient.getQueryCache().find({ queryKey: [`sandbox`, `list`] })?.options.gcTime).toBe(Number.POSITIVE_INFINITY);
    });
});

describe(`useSandbox list/mutation race`, () => {
    it(`cancels an in-flight list() so its pre-delete response can't resurrect a removed sandbox`, async () => {
        const sandbox = useSandbox();
        const a = summary(`a`);
        const b = summary(`b`);
        listMock.mockResolvedValue({ sandboxes: [a, b] });
        await sandbox.refresh();
        expect(sandbox.sandboxes.value).toEqual([a, b]);

        // A background refresh() (the liveness loop) reads the server while `b` still exists: hold it open.
        let resolveStale: (value: { sandboxes: SandboxSummary[] }) => void;
        listMock.mockImplementation(() => new Promise((resolve) => (resolveStale = resolve)));
        const stale = sandbox.refresh();
        // The user's removal completes fully (delete resolves, `removing` clears) before the stale read lands.
        vi.mocked(apiClient.sandbox.delete).mockResolvedValue({ ok: true });
        await sandbox.remove(b.id);
        expect(sandbox.sandboxes.value).toEqual([a]);
        // The stale response lands last with pre-delete truth. remove()'s cancelQueries dropped that fetch, so
        // its result is ignored (replaces the old generation guard) and `b` never comes back.
        resolveStale!({ sandboxes: [a, b] });
        await stale;
        expect(sandbox.sandboxes.value).toEqual([a]);
    });

    it(`keeps a removing row gone even when a mid-flight list() reads pre-delete server truth`, async () => {
        const sandbox = useSandbox();
        const a = summary(`a`);
        const b = summary(`b`);
        listMock.mockResolvedValue({ sandboxes: [a, b] });
        await sandbox.refresh();

        // The owner-delete is slow (Cloudflare teardown): hold it open so `b` stays in `removing`.
        let resolveDelete: (value: { ok: boolean }) => void;
        vi.mocked(apiClient.sandbox.delete).mockImplementation(() => new Promise((resolve) => (resolveDelete = resolve)));
        const removal = sandbox.remove(b.id);
        // Optimistic: the row is gone before the API resolves.
        expect(sandbox.sandboxes.value).toEqual([a]);
        // remove()'s cancelQueries adds a microtask hop before it calls delete: flush a macrotask so the
        // (held-open) delete has actually started before we drive the mid-flight read below.
        await new Promise((resolve) => setTimeout(resolve));

        // A refresh() started AFTER the optimistic drop reads pre-delete server truth [a,b]; the queryFn's
        // `removing` filter strips `b`, so it never reappears (no bogus atLimit upsell mid-removal).
        listMock.mockResolvedValue({ sandboxes: [a, b] });
        await sandbox.refresh();
        expect(sandbox.sandboxes.value).toEqual([a]);

        // Once the delete resolves, `b` is gone server-side too.
        resolveDelete!({ ok: true });
        await removal;
        listMock.mockResolvedValue({ sandboxes: [a] });
        await sandbox.refresh();
        expect(sandbox.sandboxes.value).toEqual([a]);
    });
});

describe(`reachable`, () => {
    beforeEach(() => {
        signalConnection({ kind: `disconnect` });
        resetDaemonBoot();
    });

    it(`stays false while nothing is connected`, () => {
        expect(useSandbox().reachable.value).toBe(false);
    });

    it(`goes true on a live stream to a daemon that reports nothing about its boot`, () => {
        // The pre-boot-frame daemon, and the steady state of every current one: silence means ready.
        signalConnection({ kind: `frame`, at: 0 });
        expect(useSandbox().reachable.value).toBe(true);
    });

    it(`stays false on a live stream to a daemon still converging`, () => {
        /* The whole point of the second condition. The daemon brings its listeners up before its boot chain
         * finishes, so this exact state (stream open, every data route parked on the readiness gate) used to
         * read as "go" and fire a workspace's worth of queries into it at once. */
        signalConnection({ kind: `frame`, at: 0 });
        setDaemonBoot({ ready: false, startedAt: 1_000, steps: [{ key: `registry`, label: `Loading conversations`, state: `running` }] });
        expect(useSandbox().reachable.value).toBe(false);
    });

    it(`goes true the moment the daemon's gate opens, with no reconnect`, () => {
        signalConnection({ kind: `frame`, at: 0 });
        setDaemonBoot({ ready: false, startedAt: 1_000, steps: [] });
        setDaemonBoot({ ready: true, startedAt: 1_000, steps: [] });
        expect(useSandbox().reachable.value).toBe(true);
    });

    it(`stays false for a ready daemon we have lost the stream to`, () => {
        // Readiness is the daemon's fact, liveness is ours: a ready daemon behind a dead tunnel is not reachable.
        signalConnection({ kind: `frame`, at: 0 });
        setDaemonBoot({ ready: true, startedAt: 1_000, steps: [] });
        signalConnection({ kind: `failed`, failure: { kind: `network`, message: `gone` }, at: Date.now() });
        expect(useSandbox().reachable.value).toBe(false);
    });
});
