import type { SandboxSummary } from "@intentic/api-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.mock("../../../lib/useApi", () => ({
    apiClient: { sandbox: { list: vi.fn(), delete: vi.fn(), leave: vi.fn(), hostedProvision: vi.fn(), hostedRelease: vi.fn() } },
}));
const { apiClient } = await import("../../../lib/useApi");
const listMock = vi.mocked(apiClient.sandbox.list);
const { queryClient } = await import("../../../lib/queryPersistence");
const { resetDaemonBoot, setDaemonBoot } = await import("../overview/useDaemonBoot");
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
    providedAddress: false,
    localHostname: null,
});

// Sandbox list lives in the shared query cache; clear it each test so it starts empty. refresh() forces a
// fetch past staleTime to keep the mocks deterministic.
beforeEach(() => {
    queryClient.clear();
    vi.resetAllMocks();
});

describe(`sandbox list cache retention`, () => {
    it(`pins the observer-less list entry with an explicit Infinity gcTime`, async () => {
        const sandbox = useSandbox();
        listMock.mockResolvedValue({ sandboxes: [summary(`a`)] });
        await sandbox.refresh();
        // fetchQuery-only entry: nothing else keeps it alive, so anything short of Infinity lets the default gc evict
        // it while idle. Asserts the explicit option that guards the browser.
        expect(queryClient.getQueryCache().find({ queryKey: [`sandbox`, `list`] })?.options.gcTime).toBe(Number.POSITIVE_INFINITY);
    });
});

describe(`useSandbox list/mutation race`, () => {
    it(`cannot restore a hosted machine from a provision response returned after release`, async () => {
        const sandbox = useSandbox();
        const row = summary(`a`);
        listMock.mockResolvedValue({ sandboxes: [row] });
        await sandbox.refresh();
        const provision = Promise.withResolvers<SandboxSummary>();
        vi.mocked(apiClient.sandbox.hostedProvision).mockReturnValue(provision.promise);
        const provisioning = sandbox.hostedProvision(row.id, row.token!);
        const local = { ...row, token: `local-token` };
        vi.mocked(apiClient.sandbox.hostedRelease).mockResolvedValue(local);
        await sandbox.hostedRelease(row.id);
        provision.resolve({ ...row, hosted: { region: `iad`, warm: true } });
        await provisioning;
        expect(sandbox.sandboxes.value).toEqual([local]);
        expect(apiClient.sandbox.hostedProvision).toHaveBeenCalledExactlyOnceWith({ sandboxId: row.id, token: row.token });
    });

    it(`shares a pending cancellation instead of rotating the local identity twice`, async () => {
        const sandbox = useSandbox();
        const release = Promise.withResolvers<SandboxSummary>();
        vi.mocked(apiClient.sandbox.hostedRelease).mockReturnValue(release.promise);
        const first = sandbox.hostedRelease(`a`);
        const second = sandbox.hostedRelease(`a`);
        expect(apiClient.sandbox.hostedRelease).toHaveBeenCalledExactlyOnceWith({ sandboxId: `a` });
        const local = summary(`a`);
        release.resolve(local);
        expect(await Promise.all([first, second])).toEqual([local, local]);
    });
    it(`cancels an in-flight list() so its pre-delete response can't resurrect a removed sandbox`, async () => {
        const sandbox = useSandbox();
        const a = summary(`a`);
        const b = summary(`b`);
        listMock.mockResolvedValue({ sandboxes: [a, b] });
        await sandbox.refresh();
        expect(sandbox.sandboxes.value).toEqual([a, b]);

        // Hold a background refresh() open while `b` still exists, to simulate a stale in-flight read.
        let resolveStale: (value: { sandboxes: SandboxSummary[] }) => void;
        listMock.mockImplementation(() => new Promise((resolve) => (resolveStale = resolve)));
        const stale = sandbox.refresh();
        // Let the user's removal complete fully before the stale read lands.
        vi.mocked(apiClient.sandbox.delete).mockResolvedValue({ ok: true });
        await sandbox.remove(b.id);
        expect(sandbox.sandboxes.value).toEqual([a]);
        // cancelQueries drops the stale fetch, so its late response is ignored and `b` never comes back.
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

        // Hold delete open (slow teardown) so `b` stays in `removing`.
        let resolveDelete: (value: { ok: boolean }) => void;
        vi.mocked(apiClient.sandbox.delete).mockImplementation(() => new Promise((resolve) => (resolveDelete = resolve)));
        const removal = sandbox.remove(b.id);
        expect(sandbox.sandboxes.value).toEqual([a]);
        // Flush a macrotask so the held-open delete has actually started before driving the mid-flight read below.
        await new Promise((resolve) => setTimeout(resolve));

        // The queryFn's `removing` filter strips `b` from a pre-delete read, so it doesn't reappear.
        listMock.mockResolvedValue({ sandboxes: [a, b] });
        await sandbox.refresh();
        expect(sandbox.sandboxes.value).toEqual([a]);

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
        // Silence about boot state means ready: true of the pre-boot-frame daemon and of every current one's steady
        // state.
        signalConnection({ kind: `frame`, at: 0 });
        expect(useSandbox().reachable.value).toBe(true);
    });

    it(`stays false on a live stream to a daemon still converging`, () => {
        // The daemon brings its listeners up before its state has converged; a live stream alone is not ready.
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
        // Readiness is the daemon's fact, liveness is ours: a dead stream still fails reachability.
        signalConnection({ kind: `frame`, at: 0 });
        setDaemonBoot({ ready: true, startedAt: 1_000, steps: [] });
        signalConnection({ kind: `failed`, failure: { kind: `network`, message: `gone` }, at: Date.now() });
        expect(useSandbox().reachable.value).toBe(false);
    });
});
