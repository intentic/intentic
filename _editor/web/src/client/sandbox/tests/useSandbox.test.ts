import { resetSandboxScope } from "@intentic/extension-api";
import type { SandboxSummary } from "@intentic/api-contract";
import { stubGlobal, mocked } from "@intentic/testing/bun";

stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
jest.mock("../../../lib/useApi", () => ({
    apiClient: { sandbox: { list: jest.fn(), delete: jest.fn(), leave: jest.fn(), hostedProvision: jest.fn(), hostedRelease: jest.fn(), wake: jest.fn() } },
}));
// The desktop app as the page sees it (`__INTENTIC_DESKTOP__`), and the links handed to it.
let desktop: { sandboxWakes?: boolean } | undefined;
const handed: string[] = [];
const desktopModule = { ...(await import("../../../app/environments/desktop")) };
jest.mock("../../../app/environments/desktop", () => ({
    ...desktopModule,
    desktopApp: () => desktop,
    openDesktopLink: (link: string) => handed.push(link),
}));
// The leave action, which a member's removal goes through (loaded when one happens): its own suite pins what it does.
const leaveSandbox = jest.fn();
jest.mock("../leaveSandbox", () => ({ leaveSandbox: (...args: unknown[]) => leaveSandbox(...args) }));
const { apiClient } = await import("../../../lib/useApi");
const listMock = mocked(apiClient.sandbox.list);
const { queryClient } = await import("../../../lib/queryPersistence");
const { setDaemonBoot } = await import("../useDaemonBoot");
const { signalConnection, useSandbox } = await import("../useSandbox");
const { rememberListed, rememberedAccount } = await import("../../directory/deviceDirectory");
const { activeSandboxId } = await import("../../../lib/activeSandbox");

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
    removedAt: null,
    removedBy: null,
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
    jest.resetAllMocks();
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
        mocked(apiClient.sandbox.hostedProvision).mockReturnValue(provision.promise);
        const provisioning = sandbox.hostedProvision(row.id, row.token!);
        const local = { ...row, token: `local-token` };
        mocked(apiClient.sandbox.hostedRelease).mockResolvedValue(local);
        await sandbox.hostedRelease(row.id);
        provision.resolve({ ...row, hosted: { region: `iad`, warm: true } });
        await provisioning;
        expect(sandbox.sandboxes.value).toEqual([local]);
        expect(apiClient.sandbox.hostedProvision).toHaveBeenCalledTimes(1);
        expect(apiClient.sandbox.hostedProvision).toHaveBeenCalledWith({ sandboxId: row.id, token: row.token });
    });

    it(`shares a pending cancellation instead of rotating the local identity twice`, async () => {
        const sandbox = useSandbox();
        const release = Promise.withResolvers<SandboxSummary>();
        mocked(apiClient.sandbox.hostedRelease).mockReturnValue(release.promise);
        const first = sandbox.hostedRelease(`a`);
        const second = sandbox.hostedRelease(`a`);
        expect(apiClient.sandbox.hostedRelease).toHaveBeenCalledTimes(1);
        expect(apiClient.sandbox.hostedRelease).toHaveBeenCalledWith({ sandboxId: `a` });
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
        mocked(apiClient.sandbox.delete).mockResolvedValue({ ok: true });
        await sandbox.remove(b.id);
        expect(sandbox.sandboxes.value).toEqual([a]);
        // cancelQueries drops the stale fetch, so its late response is ignored and `b` never comes back.
        resolveStale!({ sandboxes: [a, b] });
        await stale;
        expect(sandbox.sandboxes.value).toEqual([a]);
    });

    // Removed on purpose, so a later list that lacks it is no reason to offer it back (recovery/deviceDirectory.ts).
    it(`forgets a sandbox this device remembers once its removal lands`, async () => {
        const owner = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };
        const a = { ...summary(`a`), daemonUrl: `https://sandbox-82789f4106b4.sbx.intentic.dev` };
        const b = { ...summary(`b`), daemonUrl: `https://sandbox-574ea8038415.sbx.intentic.dev` };
        rememberListed(owner, [a, b], `id-1`);
        listMock.mockResolvedValue({ sandboxes: [a, b] });
        const sandbox = useSandbox();
        await sandbox.refresh();
        mocked(apiClient.sandbox.delete).mockResolvedValue({ ok: true });
        await sandbox.remove(b.id);
        expect(rememberedAccount(`owner@example.com`)?.sandboxes.map((entry) => entry.id)).toEqual([`a`]);
    });

    it(`keeps a removing row gone even when a mid-flight list() reads pre-delete server truth`, async () => {
        const sandbox = useSandbox();
        const a = summary(`a`);
        const b = summary(`b`);
        listMock.mockResolvedValue({ sandboxes: [a, b] });
        await sandbox.refresh();

        // Hold delete open (slow teardown) so `b` stays in `removing`.
        let resolveDelete: (value: { ok: boolean }) => void;
        mocked(apiClient.sandbox.delete).mockImplementation(() => new Promise((resolve) => (resolveDelete = resolve)));
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

describe(`removing a sandbox from the account`, () => {
    it(`has a member leave through the leave action, and says how the sandbox's own side went`, async () => {
        const sandbox = useSandbox();
        const a = summary(`a`);
        const shared = { ...summary(`b`), role: `collaborator` as const };
        listMock.mockResolvedValue({ sandboxes: [a, shared] });
        await sandbox.refresh();
        leaveSandbox.mockResolvedValue({ grant: `kept`, reason: `offline` });

        expect(await sandbox.remove(shared.id)).toEqual({ grant: `kept`, reason: `offline` });

        expect(leaveSandbox).toHaveBeenCalledWith(shared);
        expect(apiClient.sandbox.delete).not.toHaveBeenCalled();
        expect(sandbox.sandboxes.value).toEqual([a]);
    });

    it(`has an owner delete the row, with no leave to make`, async () => {
        const sandbox = useSandbox();
        const mine = summary(`a`);
        listMock.mockResolvedValue({ sandboxes: [mine] });
        await sandbox.refresh();
        mocked(apiClient.sandbox.delete).mockResolvedValue({ ok: true });

        expect(await sandbox.remove(mine.id)).toBeUndefined();

        expect(apiClient.sandbox.delete).toHaveBeenCalledWith({ sandboxId: mine.id });
        expect(leaveSandbox).not.toHaveBeenCalled();
    });

    it(`puts the row back when the leave fails, and passes the failure on`, async () => {
        const sandbox = useSandbox();
        const a = summary(`a`);
        const shared = { ...summary(`b`), role: `viewer` as const };
        listMock.mockResolvedValue({ sandboxes: [a, shared] });
        await sandbox.refresh();
        leaveSandbox.mockRejectedValue(new Error(`platform refused`));

        await expect(sandbox.remove(shared.id)).rejects.toThrow(`platform refused`);

        expect(sandbox.sandboxes.value).toEqual([a, shared]);
    });
});

describe(`reachable`, () => {
    beforeEach(() => {
        signalConnection({ kind: `disconnect` });
        resetSandboxScope();
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

// A sandbox found asleep is asked back from the platform; in the desktop app, one on its owner's own computer is then
// collected on this computer at once, rather than on the keeper's next poll there.
describe(`the wake a sleeping sandbox is asked back with`, () => {
    const asleep = async (row: SandboxSummary): Promise<void> => {
        listMock.mockResolvedValue({ sandboxes: [row] });
        await useSandbox().refresh();
        activeSandboxId.value = row.id;
        signalConnection({ kind: `disconnect` });
        signalConnection({ kind: `failed`, failure: { kind: `detached`, message: `no tunnel` }, at: Date.now() });
        // The watch runs, then the platform's answer.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    };

    beforeEach(() => {
        handed.length = 0;
        desktop = { sandboxWakes: true };
        mocked(apiClient.sandbox.wake).mockResolvedValue({ ok: true });
    });
    afterEach(() => {
        desktop = undefined;
        activeSandboxId.value = undefined;
    });

    it(`has the desktop app collect it on this computer once the platform has it`, async () => {
        await asleep(summary(`own-1`));
        expect(apiClient.sandbox.wake).toHaveBeenCalledWith({ sandboxId: `own-1` });
        expect(handed).toEqual([`intentic://sandbox-wakes`]);
    });

    it(`leaves a hosted machine to the platform, which starts it itself`, async () => {
        await asleep({ ...summary(`hosted-1`), hosted: { region: `iad`, warm: true } });
        expect(apiClient.sandbox.wake).toHaveBeenCalledWith({ sandboxId: `hosted-1` });
        expect(handed).toEqual([]);
    });

    it(`hands nothing to an app that does not say it collects them, nor from a browser`, async () => {
        desktop = {};
        await asleep(summary(`own-2`));
        desktop = undefined;
        await asleep(summary(`own-3`));
        expect(handed).toEqual([]);
    });

    it(`hands nothing when the platform refused the wake`, async () => {
        mocked(apiClient.sandbox.wake).mockRejectedValue(new Error(`refused`));
        await asleep(summary(`own-4`));
        expect(handed).toEqual([]);
    });
});
