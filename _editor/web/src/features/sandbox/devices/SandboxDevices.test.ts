// @vitest-environment jsdom
// jsdom because the subject is what a row puts on screen, not the derivation behind it (see deviceFacts.test.ts).
import type { Device } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { groupNeedsAttention, groupSummary, menuVerbs, primaryVerb, sandboxGroups } from "@intentic/ui";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Import chain touches the app's environment and a media query at module eval; jsdom covers both (see
// daemonRestart.test.ts).

// One desktop-sync enrollment on a row: which half it holds, and a live `seenAt` so rows read as active by
// default.
const paired = (mode: `sync` | `mirror` = `sync`, machine = `laptop`): Device[`sync`] => ({ machine, mode, seenAt: Date.now() });

const devices = ref<Device[]>([]);
// The first read, not the ten-second poll; tests below assume the list has already arrived.
const devicesLoading = ref(false);
// The machine's own CLI, run from a button, recorded rather than performed: pins that it's offered, which way
// it points, and that it names the row's own sandbox.
const mirrorCalls: { hostId: string; command: string; sandboxId?: string | undefined }[] = [];
// What the machine answers; `ok: false` reaches the row as words rather than a throw.
let mirrorAnswer: { ok: boolean; message: string } = { ok: true, message: `Port mirroring OFF for: work-abc` };
// Which machine's enrollment was revoked; needs no device connection, unlike the commands above.
const revokeCalls: string[] = [];
// The one control that starts a turn rather than a command, recorded the same way: pins that it's offered and
// what it hands the agent.
const startedTurns: string[] = [];
vi.mock(`../../agents/fleet/agentActions`, () => ({ startAgent: (prompt?: string) => startedTurns.push(prompt ?? ``) }));
// Container verbs, recorded the same way: which op left for which machine, and for `reshape`, what the form
// asked for.
const verbCalls: { hostId: string; slug: string; op: string; resources?: unknown }[] = [];
vi.mock(`./useDevices`, async () => {
    // reportStale is real, so a row's staleness reads the same rule the app uses.
    const real = await import(`./useDevices`);
    return {
        ...real,
        useDevices: () => ({ devices, error: ref(undefined), isLoading: devicesLoading, refetch: () => {} }),
        manageDeviceSandbox: (hostId: string, slug: string, op: string, payload?: { resources?: unknown }) => {
            verbCalls.push({ hostId, slug, op, ...(payload?.resources === undefined ? {} : { resources: payload.resources }) });
            return Promise.resolve(`Reshaped sandbox "${slug}".`);
        },
        runDeviceCommand: (hostId: string, command: string, sandboxId?: string) => {
            mirrorCalls.push({ hostId, command, sandboxId });
            return Promise.resolve(mirrorAnswer);
        },
        revokeSyncDevice: (machine: string) => {
            revokeCalls.push(machine);
            return Promise.resolve();
        },
    };
});
// Revoking another device's access is owner-only, matching the daemon's own floor.
const owner = ref(true);
vi.mock(`../secrets/useRole`, () => ({ useRole: () => ({ isOwner: owner }) }));
// sandboxKey is reached at module eval by the real useDevices, so it's mocked here too.
vi.mock(`../client/useSandbox`, () => ({
    useSandbox: () => ({ daemonUrl: ref(undefined) }),
    sandboxKey: (name: string) => [name],
}));
// The release this sandbox knows about; mocked like useDevices since the subject is what a row says, and
// staleness is part of that.
const latest = ref<string | undefined>(`1.183.0`);
vi.mock(`../overview/useSandboxVersion`, () => ({ useSandboxVersion: () => ({ latest }) }));
// The owner's per-device switches, so a row can say "Manage sandboxes is off" before a click; mocked since the
// real hook needs vue-query's injected client.
const capabilities = ref<{ id: string; config: Record<string, string> }[]>([]);
vi.mock(`../../capabilities/connect/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities }) }));
// The two cards below the list have their own daemon calls; this mounts the list alone.
vi.mock(`./DesktopSyncCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`../access/ControlTokensSection.vue`, () => ({ default: defineComponent({ render: () => null }) }));
// A blocked machine's "open its permissions" is now a link, so the mock stubs one.
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ query: {} }) as never,
    useRouter: () => ({ push: () => {} }) as never,
    RouterLink: (await import(`../../../testing/routerLinkStub`)).RouterLinkStub as never,
}));

// Counts how often the list re-derives, through the one function every row's derivation passes through
// (agentStalled).
let derivations = 0;
vi.mock(import(`@intentic/sandbox-contract`), async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        agentStalled: ((...args: Parameters<typeof real.agentStalled>) => {
            derivations += 1;
            return real.agentStalled(...args);
        }) as never,
    };
});

// This sandbox's runners on a machine; mocked since the real hook is a vue-query read this bare app has no
// client for.
const runnersList = ref<{ id: string; host?: string; online: boolean; parity?: string; facts?: { cpus: number; memoryMb: number; load: number } }[]>(
    [],
);
vi.mock(`./useRunners`, () => ({
    useRunners: () => ({ runners: runnersList, ready: runnersList, isLoading: ref(false), refetch: () => {} }),
    createRunner: () => Promise.resolve(`made`),
    removeRunner: () => Promise.resolve(`removed`),
    forgetRunner: () => Promise.resolve(),
}));

const { default: SandboxDevices } = await import("./SandboxDevices.vue");

let app: App | undefined;
// A second mount retires the first: a leaked app stays subscribed to `devices` and re-renders against DOM
// afterEach already emptied.
const mount = (rows: Device[]): HTMLElement => {
    app?.unmount();
    document.body.innerHTML = ``;
    devices.value = rows;
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxDevices) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    // The confirmation dialogs are PrimeVue Dialogs and read the plugin's config while rendering.
    app.use(PrimeVue);
    app.mount(el);
    return el;
};

// A device and a sandbox both disclose by pressing the line that names them.
const disclosures = (el: HTMLElement): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>(`button[aria-expanded]`)];
const openRow = async (el: HTMLElement, name: string): Promise<void> => {
    disclosures(el)
        .find((button) => (button.textContent ?? ``).includes(name))
        ?.click();
    await nextTick();
};

afterEach(() => {
    latest.value = `1.183.0`;
    runnersList.value = [];
    devicesLoading.value = false;
    capabilities.value = [];
    owner.value = true;
    mirrorCalls.length = 0;
    verbCalls.length = 0;
    revokeCalls.length = 0;
    startedTurns.length = 0;
    mirrorAnswer = { ok: true, message: `Port mirroring OFF for: work-abc` };
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    // The app's clock is a module singleton; a test that faked time would hand the next one a frozen one.
    vi.useRealTimers();
});

it(`says what a device is when it has no report to show`, () => {
    const el = mount([
        {
            key: `radarsu-rog`,
            label: `radarsu-rog`,
                        hostId: `radarsu-rog`,
            online: true,
            platform: `windows`,
            facts: {
                os: `Windows 11 Pro (build 10.0.26100)`,
                arch: `x64`,
                shell: `PowerShell 7`,
                home: `C:\\Users\\ada`,
                roots: [`C:\\Users\\ada`],
            },
            agentVersion: `0.5.1`,
            gap: `no-agent`,
        },
    ]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`Windows 11 Pro`);
    expect(text).toContain(`x64`);
    expect(text).toContain(`PowerShell 7`);
    // The OS doesn't answer the gap: this machine still has no agent.
    expect(text).toContain(`no agent`);
});

it(`falls back to the platform, and ages a device that is not here`, () => {
    const el = mount([
        {
            key: `linux`,
            label: `linux`,
                        hostId: `linux`,
            online: false,
            platform: `linux`,
            lastSeen: Date.now() - 3 * 60 * 60_000,
            gap: `offline`,
        },
    ]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`Linux`);
    expect(text).toContain(`last seen 3h ago`);
});

// Names chosen so alphabetical order is the exact opposite of the useful order.
it(`puts the machines worth reading first`, () => {
    const report = (capturedAt: number): Device[`report`] => ({
        hostname: `host`,
        os: `linux`,
        sandboxes: [],
        pairings: [],
        ports: [],
        agent: { running: true, installed: `0.1.0` },
        capturedAt,
    });
    const el = mount([
        { key: `a`, label: `a-offline`, hostId: `a`, online: false, platform: `linux`, gap: `offline` },
        { key: `b`, label: `b-quiet`, sync: paired(), platform: `linux`, report: report(Date.now() - 60 * 60_000) },
        { key: `c`, label: `c-attention`, hostId: `c`, online: true, platform: `linux`, gap: `no-agent` },
        { key: `d`, label: `d-live`, sync: paired(), platform: `linux`, report: report(Date.now()) },
    ]);
    const text = el.textContent ?? ``;
    const at = (label: string): number => text.indexOf(label);
    expect(at(`d-live`)).toBeLessThan(at(`c-attention`));
    expect(at(`c-attention`)).toBeLessThan(at(`b-quiet`));
    expect(at(`b-quiet`)).toBeLessThan(at(`a-offline`));
});

it(`names the image each sandbox on the machine is running, once the row is open`, async () => {
    const el = mount([
        {
            key: `laptop`,
            label: `laptop`,
            sync: paired(),
            platform: `linux`,
            report: {
                hostname: `laptop`,
                os: `linux`,
                sandboxes: [{ slug: `work`, container: `intentic-sandbox-work`, running: true, image: `ghcr.io/intentic/sandbox:2.3.1` }],
                pairings: [],
                ports: [],
                agent: { running: true, installed: `0.1.0` },
                capturedAt: Date.now(),
            },
        },
    ]);
    expect(el.textContent ?? ``).not.toContain(`ghcr.io/intentic/sandbox:2.3.1`);
    await openRow(el, `work`);
    expect(el.textContent ?? ``).toContain(`ghcr.io/intentic/sandbox:2.3.1`);
});

// The container verb buttons are shared with the desktop app's own manager window (<SandboxVerbs>), so what's
// asserted here holds for both.
const managed = (running: boolean): Device => ({
    key: `laptop`,
    label: `laptop`,
    // No desktop-sync enrollment: the right fixture for container verbs and for asserting no revoke without one.
    platform: `linux`,
    hostId: `host-1`,
    online: true,
    report: {
        hostname: `laptop`,
        os: `linux`,
        sandboxes: [{ slug: `work`, container: `intentic-sandbox-work`, running, image: `ghcr.io/intentic/sandbox:2.3.1` }],
        pairings: [],
        ports: [],
        agent: { running: true, installed: `1.183.0` },
        capturedAt: Date.now(),
    },
});

// Every control by label, anchors included, since a control that goes somewhere is a link.
const labels = (el: HTMLElement): string[] => [...el.querySelectorAll(`button, a`)].map((control) => control.textContent?.trim() ?? ``);

// Every switch granted: the state the verb tests below assume; without it the row states the missing grant
// instead.
const granted = (): void => {
    capabilities.value = [{ id: `host-1`, config: { platform: `linux`, shell: `on`, sandboxes: `on`, sandboxRemove: `on` } }];
};

it(`puts one verb on the row and everything else behind a menu`, () => {
    granted();
    const el = mount([managed(true)]);
    const found = labels(el);
    expect(found).toContain(`Stop`);
    // The overflow menu is a glyph, named for assistive tech rather than in words on the row.
    expect(el.querySelector(`button[aria-label="More actions"]`)).not.toBeNull();
    for (const verb of [`Restart`, `Update`, `Roll back`, `Resources…`, `Logs`, `Remove`]) {
        expect(found).not.toContain(verb);
    }
});

it(`offers Start, and no Stop, on a sandbox that is not running`, () => {
    granted();
    const found = labels(mount([managed(false)]));
    expect(found).toContain(`Start`);
    expect(found).not.toContain(`Stop`);
});

// Pinned as vocabulary rather than via the teleported overlay, since the model is what both apps read.
it(`keeps the menu's vocabulary the same for both apps`, () => {
    expect(primaryVerb(true)).toBe(`stop`);
    expect(primaryVerb(false)).toBe(`start`);
    expect(menuVerbs(true)).toEqual([`restart`, `logs`, `resources`, `update`, `rollback`]);
    expect(menuVerbs(false)).toEqual([`logs`, `resources`, `update`, `rollback`]);
});

// The sandbox's share of the machine, and the Resources form that changes it (reshape carries only what changed).
const GIB = 1024 ** 3;
// A connected, permitted machine with a 12 GiB/4-core cap, privileged by the environment, and a 20 GiB/12-core
// engine to bound the form.
const shared = (): Device => {
    const row = managed(true);
    return {
        ...row,
        facts: { os: `Ubuntu 24.04`, arch: `x64`, shell: `bash`, home: `/home/ada`, roots: [`/home/ada`], engine: { memoryBytes: 20 * GIB, cpus: 12 } },
        report: {
            ...row.report!,
            sandboxes: [
                {
                    ...row.report!.sandboxes[0]!,
                    resources: { memoryBytes: 12 * GIB, cpus: 4, privileged: true, gpu: false, hostRuntime: [], overlayRuntime: [`--privileged`] },
                },
            ],
        },
    };
};

it(`says what a sandbox gets of the machine, once the row is open`, async () => {
    granted();
    const el = mount([shared()]);
    expect(el.textContent ?? ``).not.toContain(`12 GiB`);
    await openRow(el, `work`);
    expect(el.textContent ?? ``).toContain(`12 GiB · 4 CPUs · privileged`);
});

// Everything on screen, including the teleported dialog and menu (both mount past `el`).
const everything = (): string => document.body.textContent ?? ``;
// A menu row is a link named by the verb's label; a dialog's button teleports past the row's, so the last
// match is the modal's.
const menuRow = (label: string): HTMLAnchorElement | undefined =>
    [...document.body.querySelectorAll(`a`)].find((row) => (row.textContent ?? ``).trim() === label);
const dialogButton = (label: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].findLast((control) => (control.textContent ?? ``).trim() === label);

it(`opens the Resources form on the row's own share and sends only what changed, as a reshape`, async () => {
    granted();
    const el = mount([shared()]);
    el.querySelector<HTMLButtonElement>(`button[aria-label="More actions"]`)?.click();
    await nextTick();
    menuRow(`Resources…`)?.click();
    await nextTick();
    expect(everything()).toContain(`Resources for work`);

    const memory = document.body.querySelector<HTMLInputElement>(`input[aria-label="Memory cap in GiB"]`);
    expect(memory).toHaveProperty(`value`, `12`);
    // The rails are the engine's: 20 GiB minus the 3 the host keeps.
    expect(everything()).toContain(`4 to 17 on this computer`);
    // The environment's privilege isn't the owner's to withdraw, and the switch says why.
    expect(document.body.querySelector(`input[aria-label="Run privileged"]`)).toHaveProperty(`disabled`, true);
    expect(everything()).toContain(`approved environment requires this`);
    expect(dialogButton(`Apply`)).toHaveProperty(`disabled`, true);

    memory!.value = `16`;
    memory!.dispatchEvent(new Event(`input`));
    await nextTick();
    expect(dialogButton(`Apply`)).toHaveProperty(`disabled`, false);
    dialogButton(`Apply`)?.click();
    await nextTick();
    expect(verbCalls).toEqual([{ hostId: `host-1`, slug: `work`, op: `reshape`, resources: { memoryGib: 16 } }]);
});

it(`says nothing about connecting a device that is already managing its sandboxes`, () => {
    granted();
    const text = mount([managed(true)]).textContent ?? ``;
    expect(text).not.toContain(`Connect it as a device`);
    expect(text).not.toContain(`Manage sandboxes on this device`);
    expect(text).not.toContain(`Remove sandboxes from this device`);
});

// A machine paired by the desktop app alone: that door never reports containers, so this row used to show an
// empty sandbox list with no buttons.
const syncOnly = (): Device => ({
    key: `laptop`,
    label: `laptop`,
    sync: paired(),
    platform: `windows`,
    report: {
        hostname: `laptop`,
        os: `win32`,
        // Empty because the sync agent never reports containers.
        sandboxes: [],
        pairings: [{ sandboxId: `work-abc`, mode: `sync`, localDir: `C:\\Users\\ada\\work`, mutagenStatus: `watching` }],
        ports: [],
        agent: { running: true, installed: `1.183.0` },
        capturedAt: Date.now(),
    },
});

it(`explains why a sync-only device has no sandbox buttons, and offers the fix`, () => {
    const el = mount([syncOnly()]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`Desktop sync carries folders and ports, never containers`);
    expect(labels(el)).toContain(`Connect this device`);
    expect(labels(el)).not.toContain(`Restart`);
});

it(`explains the gap without a button when there is no card to connect the machine`, () => {
    const el = mount([{ ...syncOnly(), platform: `macos` }]);
    expect(el.textContent ?? ``).toContain(`Desktop sync carries folders and ports, never containers`);
    expect(labels(el)).not.toContain(`Connect this device`);
});

it(`names the switch a connected device is missing before anything is clicked`, () => {
    capabilities.value = [{ id: `host-1`, config: { platform: `linux`, shell: `on` } }];
    const el = mount([managed(true)]);
    expect(el.textContent ?? ``).toContain(`Manage sandboxes on this device`);
    expect(labels(el)).toContain(`Open its permissions`);
});

it(`names the removal switch on a machine that may do everything else`, () => {
    capabilities.value = [{ id: `host-1`, config: { platform: `linux`, shell: `on`, sandboxes: `on` } }];
    const text = mount([managed(true)]).textContent ?? ``;
    expect(text).toContain(`Remove sandboxes from this device`);
    expect(text).not.toContain(`Turn on "Manage sandboxes on this device"`);
});

// Folding only helps if the closed line still answers "is this one fine"; these pin both what disappears and
// what must not.
const busyMachine = (): Device => ({
    key: `rog`,
    label: `radarsu-rog`,
    sync: paired(),
    platform: `linux`,
    hostId: `host-1`,
    online: true,
    report: {
        hostname: `radarsu-rog`,
        os: `linux`,
        sandboxes: [
            { slug: `sandbox-bce57bb9fe3b`, container: `c1`, running: true, image: `img:a` },
            { slug: `sandbox-0738cd6b5027`, container: `c2`, running: true, image: `img:b` },
            { slug: `sandbox-4c64429cade7`, container: `c3`, running: false, image: `img:c` },
        ],
        pairings: [
            { sandboxId: `sandbox-bce57bb9fe3b`, mode: `sync`, localDir: `/home/radarsu/intentic/radarsu-web-platform-bce57bb9fe3b` },
            { sandboxId: `sandbox-0738cd6b5027`, mode: `sync`, localDir: `/home/radarsu/intentic/radarsu-local-0738cd6b5027` },
        ],
        ports: [
            { port: 8788, host: `127.0.0.1`, sandboxId: `sandbox-bce57bb9fe3b`, state: `mirrored` },
            { port: 33177, host: `127.0.0.1`, sandboxId: `sandbox-bce57bb9fe3b`, state: `mirrored` },
            { port: 5440, host: `127.0.0.1`, sandboxId: `sandbox-0738cd6b5027`, state: `busy` },
        ],
        agent: { running: true, installed: `1.183.0` },
        capturedAt: Date.now(),
    },
});

it(`titles a sandbox by its folder rather than by a blob of hex`, () => {
    const text = mount([busyMachine()]).textContent ?? ``;
    expect(text).toContain(`radarsu-web-platform-bce57bb9fe3b`);
    expect(text).toContain(`radarsu-local-0738cd6b5027`);
    expect(text).toContain(`sandbox-bce57bb9fe3b`);
});

it(`folds a sandbox to a line that still says what is under it`, () => {
    granted();
    const text = mount([busyMachine()]).textContent ?? ``;
    expect(text).toContain(`2 ports`);
    expect(text).not.toContain(`/home/radarsu/intentic/radarsu-web-platform-bce57bb9fe3b`);
    expect(text).not.toContain(`img:a`);
});

it(`opens the sandbox that wants something and leaves the rest folded`, () => {
    granted();
    const text = mount([busyMachine()]).textContent ?? ``;
    expect(text).toContain(`/home/radarsu/intentic/radarsu-local-0738cd6b5027`);
    expect(text).toContain(`not on localhost`);
    // Being stopped on purpose is not an errand, so that row stays folded.
    expect(text).not.toContain(`img:c`);
});

// A conflict is the state a reader is least equipped to act on directly; the paths ride in the machine's own
// report (sync/mutagen.ts conflictsFrom).
const conflicted = (conflicts = 10): Device => {
    const machine = busyMachine();
    const report = machine.report!;
    return {
        ...machine,
        report: {
            ...report,
            pairings: report.pairings.map((pairing) =>
                pairing.sandboxId === `sandbox-0738cd6b5027`
                    ? {
                          ...pairing,
                          mutagenStatus: `watching`,
                          conflicts,
                          conflictedPaths: [
                              { path: `.claude/settings.json`, local: `modified`, sandbox: `modified` },
                              { path: `docs/notes.md`, local: `deleted`, sandbox: `modified` },
                          ],
                      }
                    : pairing,
            ),
        },
    };
};

it(`explains a conflict instead of counting it, and names the files it is about`, () => {
    const text = mount([conflicted()]).textContent ?? ``;
    // The badge still summarises on the closed line; the count is Mutagen's own total.
    expect(text).toContain(`10 conflicts`);
    expect(text).toContain(`neither copy was overwritten`);
    expect(text).toContain(`Make the two copies match`);
    expect(text).toContain(`.claude/settings.json`);
    expect(text).toContain(`changed on this device`);
    expect(text).toContain(`deleted on this device`);
    // Two of ten shown; the rest is counted rather than implied away.
    expect(text).toContain(`and 8 more`);
});

it(`says why a list is missing rather than counting rows it does not have`, () => {
    const machine = conflicted();
    const report = machine.report!;
    const text =
        mount([
            {
                ...machine,
                report: {
                    ...report,
                    pairings: report.pairings.map((pairing) => ({ ...pairing, conflictedPaths: undefined })),
                },
            },
        ]).textContent ?? ``;
    expect(text).toContain(`10 conflicts`);
    expect(text).toContain(`neither copy was overwritten`);
    expect(text).toContain(`doesn't report which paths`);
    expect(text).not.toContain(`and 10 more`);
});

// Choosing between two edited copies is per-file judgement, so the remedy is a turn, not a one-click winner.
it(`offers a turn that can reach both copies, and hands it the paths`, () => {
    const el = mount([conflicted()]);
    expect(labels(el)).toContain(`Fix with agent`);
    [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).trim() === `Fix with agent`)?.click();
    expect(startedTurns).toHaveLength(1);
    expect(startedTurns[0]).toContain(`.claude/settings.json`);
    expect(startedTurns[0]).toContain(`radarsu-rog`);
    expect(startedTurns[0]).toContain(`/home/radarsu/intentic/radarsu-local-0738cd6b5027`);
});

it(`keeps the explanation and drops the button when the machine is not reachable`, () => {
    const text = mount([{ ...conflicted(), online: false, gap: `offline` }]);
    expect(text.textContent ?? ``).toContain(`.claude/settings.json`);
    expect(labels(text)).not.toContain(`Fix with agent`);
});

it(`folds a device to a line that counts what is under it`, async () => {
    const el = mount([busyMachine()]);
    await openRow(el, `radarsu-rog`);
    const text = el.textContent ?? ``;
    expect(text).toContain(`3 sandboxes`);
    expect(text).toContain(`2 running`);
    expect(text).toContain(`1 needs attention`);
});

// The hand-rolled rows had none of <DisclosureRow>'s wash or its `aria-controls`; they're that component now.
it(`lights an open device the way the rest of the hub does, and names the block it opened`, async () => {
    const el = mount([busyMachine()]);
    const washed = (): Element[] => [...el.querySelectorAll(`[class*="bg-content/6"]`)];
    expect(washed()).toHaveLength(1);
    expect(washed()[0]?.textContent ?? ``).toContain(`radarsu-rog`);

    const toggle = disclosures(el).find((button) => (button.textContent ?? ``).includes(`radarsu-rog`));
    expect(toggle?.getAttribute(`aria-expanded`)).toBe(`true`);
    expect(el.querySelector(`#${toggle?.getAttribute(`aria-controls`) ?? `none`}`)).not.toBeNull();

    await openRow(el, `radarsu-rog`);
    expect(washed()).toHaveLength(0);
});

it(`finds a machine by a port number and opens what matched`, async () => {
    const el = mount([busyMachine(), { ...syncOnly(), key: `other`, label: `other-pc` }]);
    const field = el.querySelector(`input`);
    expect(field).not.toBeNull();
    field!.value = `8788`;
    field!.dispatchEvent(new Event(`input`));
    await nextTick();
    const text = el.textContent ?? ``;
    expect(text).toContain(`radarsu-rog`);
    expect(text).not.toContain(`other-pc`);
    expect(text).toContain(`localhost:8788`);
});

it(`says when a filter matched nothing`, async () => {
    const el = mount([busyMachine(), { ...syncOnly(), key: `other`, label: `other-pc` }]);
    const field = el.querySelector(`input`);
    field!.value = `zzzz`;
    field!.dispatchEvent(new Event(`input`));
    await nextTick();
    expect(el.textContent ?? ``).toContain(`matches`);
});

// An agent five days behind a fix, with the row saying only its bare version throughout: true and useless
// without what it should be.
const behind = (): Device => ({
    key: `laptop`,
    label: `laptop`,
    sync: paired(),
    platform: `linux`,
    report: {
        hostname: `laptop`,
        os: `linux`,
        sandboxes: [],
        pairings: [],
        ports: [],
        agent: { running: true, installed: `0.1.0` },
        capturedAt: Date.now(),
    },
});

it(`says when a device's agent is behind, and offers the update as a button`, () => {
    const el = mount([behind()]);
    const text = el.textContent ?? ``;
    // The door and the version are separate chips now: the version belongs to the agent, not the enrollment mode.
    expect(text).toContain(`desktop sync`);
    expect(text).toContain(`agent`);
    expect(text).toContain(`0.1.0`);
    expect(text).toContain(`1.183.0 available`);
    // No button on a sync-only row: an update runs over the device connection, which this device has never had.
    expect(labels(el)).not.toContain(`Update agent`);
});

// With that door open it's a button instead of a command to type, replacing what this view printed for years.
it(`offers the update as a button once the device is connected for commands`, () => {
    const el = mount([{ ...behind(), hostId: `host-1`, online: true }]);
    expect(labels(el)).toContain(`Update agent`);
    expect(el.textContent ?? ``).not.toContain(`intentic-machine upgrade`);
});

it(`says nothing about updating a device that is already current`, () => {
    const row = behind();
    const el = mount([{ ...row, report: { ...row.report!, agent: { ...row.report!.agent, installed: `1.183.0` } } }]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`desktop sync`);
    expect(text).toContain(`1.183.0`);
    expect(text).not.toContain(`available`);
    expect(labels(el)).not.toContain(`Update agent`);
});

// A different errand from an old binary: the file on disk is current but the running loop isn't, since
// replacing a file doesn't touch a running process.
it(`offers a restart, not an update, when the loop is behind the installed build`, () => {
    const row = behind();
    // A restart travels over the device connection; a sync-only row states the skew and offers nothing.
    const el = mount([
        {
            ...row,
            hostId: `host-1`,
            online: true,
            report: { ...row.report!, agent: { running: true, pid: 4242, build: `0.1.0`, installed: `1.183.0` } },
        },
    ]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`0.1.0`);
    expect(text).toContain(`1.183.0`);
    expect(labels(el)).toContain(`Restart agent`);
    expect(labels(el)).not.toContain(`Update agent`);
    expect(text).not.toContain(`intentic-machine run --stop`);
});

it(`says nothing about restarting a device whose loop is on the installed build`, () => {
    const row = behind();
    const el = mount([
        {
            ...row,
            report: { ...row.report!, agent: { running: true, pid: 4242, build: `1.183.0`, installed: `1.183.0` } },
        },
    ]);
    expect(labels(el)).not.toContain(`Restart agent`);
    expect(labels(el)).not.toContain(`Update agent`);
});

it(`makes no claim when this sandbox doesn't know the latest release`, () => {
    latest.value = undefined;
    const el = mount([behind()]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`desktop sync`);
    expect(text).toContain(`0.1.0`);
    expect(text).not.toContain(`available`);
    expect(labels(el)).not.toContain(`Update agent`);
});

// The invitation is a claim about the reader; an empty `devices` means "no device paired" only once the read
// has actually finished.
it(`does not offer to pair a first device while the list is still being read`, () => {
    devicesLoading.value = true;
    expect(mount([]).textContent ?? ``).not.toContain(`No device is paired`);
});

it(`offers to pair a first device once the read lands empty`, () => {
    devicesLoading.value = false;
    expect(mount([]).textContent ?? ``).toContain(`No device is paired`);
});

// Every derivation on this tab hangs off the app's one-second clock, so a regression here silently re-renders
// the whole list every tick for data that arrives every ten.
it(`does not re-derive the whole list on every tick of the app clock`, async () => {
    vi.useFakeTimers();
    // A round instant, so three seconds of ticking can't cross a bucket boundary and legitimately re-derive.
    vi.setSystemTime(1_700_000_000_000);
    mount([managed(true), { ...managed(false), key: `desktop`, label: `desktop` }]);
    await nextTick();

    const derivedOnce = derivations;
    expect(derivedOnce).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(3_000);
    await nextTick();
    expect(derivations).toBe(derivedOnce);
});

// A runner belongs to this sandbox, not to a person's workspace; filtered by host, since the buttons are that
// machine's.
it(`lists this sandbox's runners under the device holding them, with what that machine has to offer`, async () => {
    runnersList.value = [
        { id: `rig`, host: `host-1`, online: true, facts: { cpus: 16, memoryMb: 26_048, load: 0.25 } },
        { id: `elsewhere`, host: `other-host`, online: true },
    ];
    const el = mount([managed(true)]);
    await nextTick();
    const text = el.textContent ?? ``;
    expect(text).toContain(`Runners for this sandbox`);
    expect(text).toContain(`rig`);
    expect(text).toContain(`16 cores`);
    expect(text).not.toContain(`elsewhere`);
});

it(`keeps an offline runner's row and names the state rather than hiding it`, async () => {
    runnersList.value = [{ id: `rig`, host: `host-1`, online: false }];
    const el = mount([managed(true)]);
    await nextTick();
    expect(el.textContent ?? ``).toContain(`Offline`);
});

it(`shows the runners section and add control on a machine that has none`, async () => {
    const el = mount([managed(true)]);
    await nextTick();
    const text = el.textContent ?? ``;
    expect(text).toContain(`Runners for this sandbox`);
    expect(text).toContain(`Add runner`);
});

it(`marks a runner whose build has drifted from this sandbox, and offers the update`, async () => {
    runnersList.value = [{ id: `rig`, host: `host-1`, online: true, parity: `outdated` }];
    const el = mount([managed(true)]);
    await nextTick();
    const text = el.textContent ?? ``;
    expect(text).toContain(`outdated`);
    expect(text).toContain(`Update`);
});

it(`says nothing about the build of a runner that matches`, async () => {
    runnersList.value = [{ id: `rig`, host: `host-1`, online: true, parity: `current` }];
    const el = mount([managed(true)]);
    await nextTick();
    expect(el.textContent ?? ``).not.toContain(`outdated`);
    expect(el.textContent ?? ``).not.toContain(`Update`);
});

// A sandbox's dev server can take a port on the user's own desk; the switch lives on the machine (it must hold
// while the sandbox sleeps), so these buttons run that machine's CLI rather than set a local flag.
// `null` means no device door; `undefined` would take the default instead.
const mirrored = (state: `on` | `off`, door: { hostId: string; online: boolean } | null = { hostId: `host-1`, online: true }): Device => ({
    key: `laptop`,
    label: `laptop`,
    sync: paired(),
    platform: `linux`,
    ...door,
    report: {
        hostname: `laptop`,
        os: `linux`,
        sandboxes: [{ slug: `work`, container: `intentic-sandbox-work`, running: true, image: `img:a` }],
        pairings: [{ sandboxId: `work-abc`, mode: `sync`, localDir: `/home/ada/work`, mutagenStatus: `watching`, mirroring: state }],
        // The port is carried in both states on purpose: the one-tick reading between the switch flipping and the
        // machine tearing its forwards down.
        ports: [{ port: 5173, host: `127.0.0.1`, sandboxId: `work-abc`, state: `mirrored`, command: `node vite` }],
        agent: { running: true, installed: `1.183.0` },
        capturedAt: Date.now(),
    },
});

// With mirroring off the machine reports no ports, which used to render as no line at all — identical to a
// sandbox serving nothing.
it(`says a device was told to keep its localhost clear, and offers the way back`, async () => {
    const el = mount([mirrored(`off`)]);
    await openRow(el, `work`);
    const text = el.textContent ?? ``;
    expect(text).toContain(`isn't putting this sandbox's ports on its own localhost`);
    expect(labels(el)).toContain(`Start mirroring`);
    expect(labels(el)).not.toContain(`Stop mirroring`);
    // Suppressed rather than printed under the sentence contradicting it.
    expect(text).not.toContain(`localhost:5173`);
});

// Bare, the machine's CLI acts on every sandbox it pairs; the button must travel with this row's own sandbox id.
it(`takes this sandbox's ports off that device's localhost, and nobody else's`, async () => {
    const el = mount([mirrored(`on`)]);
    await openRow(el, `work`);
    expect(el.textContent ?? ``).toContain(`localhost:5173`);
    const button = [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).includes(`Stop mirroring`));
    button?.click();
    await nextTick();
    expect(mirrorCalls).toEqual([{ hostId: `host-1`, command: `mirror-off`, sandboxId: `work-abc` }]);
});

// The CLI's own sentence is kept, naming more than this side knows.
it(`shows the machine's own answer under the row that was pressed`, async () => {
    const el = mount([mirrored(`on`)]);
    await openRow(el, `work`);
    [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).includes(`Stop mirroring`))?.click();
    await nextTick();
    await nextTick();
    expect(el.textContent ?? ``).toContain(`Port mirroring OFF for: work-abc`);
});

// A refusal is an answer, not a crash: it arrives as the machine explaining itself.
it(`keeps the machine's words when it declines to do it`, async () => {
    mirrorAnswer = { ok: false, message: `Turn on "Run commands" for this device.` };
    const el = mount([mirrored(`on`)]);
    await openRow(el, `work`);
    [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).includes(`Stop mirroring`))?.click();
    await nextTick();
    await nextTick();
    expect(el.textContent ?? ``).toContain(`Turn on "Run commands" for this device.`);
});

// The row can still say mirroring is off, but the switch needs the device connection; a button that fails when
// pressed is worse than no button.
it(`states mirroring without offering the switch on a device it cannot run commands on`, async () => {
    const el = mount([mirrored(`off`, null)]);
    await openRow(el, `work`);
    expect(el.textContent ?? ``).toContain(`isn't putting this sandbox's ports on its own localhost`);
    expect(labels(el)).not.toContain(`Start mirroring`);
});

// Mirroring off is a fact, not a fault: it must not unfold the row or warn, since that's exactly what was
// asked for.
it(`counts mirroring off as a fact rather than something to fix`, () => {
    const groups = sandboxGroups(
        [{ sandboxId: `work-abc`, mode: `sync`, localDir: `/home/ada/work`, mutagenStatus: `watching`, mirroring: `off` }],
        [{ port: 5173, sandboxId: `work-abc`, state: `busy` }],
    );
    expect(groups.map((group) => groupSummary(group))).toEqual([{ facts: [`mirroring off`], warnings: [] }]);
    expect(groups.filter(groupNeedsAttention)).toEqual([]);
});

// The same port with mirroring on still warns, so the fact-not-fault rule above doesn't swallow a real signal.
it(`still warns about a port that missed localhost while mirroring is on`, () => {
    const groups = sandboxGroups(
        [{ sandboxId: `work-abc`, mode: `sync`, localDir: `/home/ada/work`, mutagenStatus: `watching`, mirroring: `on` }],
        [{ port: 5173, sandboxId: `work-abc`, state: `busy` }],
    );
    expect(groups.map((group) => groupSummary(group))).toEqual([{ facts: [], warnings: [`1 port not on localhost`] }]);
    expect(groups.filter(groupNeedsAttention)).toHaveLength(1);
});

// A card under this list used to hold the whole subject in the singular; now each row states its own enrollment.

// A ports-only machine: no folder, no file sync, must never be described as syncing files.
const mirrorOnly = (): Device => ({
    key: `colleague`,
    label: `colleague-pc`,
    sync: paired(`mirror`, `colleague`),
    platform: `linux`,
    report: {
        hostname: `colleague`,
        os: `linux`,
        sandboxes: [],
        pairings: [{ sandboxId: `work-abc`, mode: `mirror` }],
        ports: [{ port: 5173, host: `127.0.0.1`, sandboxId: `work-abc`, state: `mirrored` }],
        agent: { running: true, installed: `1.183.0` },
        capturedAt: Date.now(),
    },
});

it(`says which half of desktop sync each device holds`, () => {
    const text = mount([mirrored(`on`), mirrorOnly()]).textContent ?? ``;
    expect(text).toContain(`syncing files and ports`);
    expect(text).toContain(`mirroring ports`);
    expect(text).toContain(`ports only`);
});

// An unused enrollment used to read as healthy everywhere: the record exists, so every surface called it fine.
it(`warns about a device whose enrollment has gone quiet`, () => {
    const row = mirrored(`on`);
    const text = mount([{ ...row, sync: { machine: `laptop`, mode: `sync` } }]).textContent ?? ``;
    expect(text).toContain(`never checked in`);
});

it(`treats an enrollment last used hours ago as stopped`, () => {
    const row = mirrored(`on`);
    const text = mount([{ ...row, sync: { machine: `laptop`, mode: `sync`, seenAt: Date.now() - 3 * 60 * 60_000 } }]).textContent ?? ``;
    expect(text).toContain(`stopped`);
});

// Pause had no button before: the row's own sandbox id travels with the command, same as mirroring's.
it(`pauses this pairing's file syncing, and nobody else's`, async () => {
    const el = mount([mirrored(`on`)]);
    await openRow(el, `work`);
    [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).includes(`Pause syncing`))?.click();
    await nextTick();
    expect(mirrorCalls).toEqual([{ hostId: `host-1`, command: `sync-pause`, sandboxId: `work-abc` }]);
});

// The label points whichever way the machine currently reports, like the mirroring switch.
it(`offers Resume, and no Pause, on a pairing the machine reports as paused`, async () => {
    const row = mirrored(`on`);
    const paused = {
        ...row,
        report: { ...row.report!, pairings: [{ ...row.report!.pairings[0]!, paused: true }] },
    };
    const el = mount([paused]);
    await openRow(el, `work`);
    expect(labels(el)).toContain(`Resume syncing`);
    expect(labels(el)).not.toContain(`Pause syncing`);
});

// A mirror enrollment has no session to pause; better no button than one that always refuses.
it(`does not offer to pause a device that only mirrors ports`, async () => {
    const el = mount([{ ...mirrorOnly(), hostId: `host-1`, online: true }]);
    await openRow(el, `work-abc`);
    expect(labels(el)).not.toContain(`Pause syncing`);
    // Mirroring is still switchable: that half is exactly what a mirror enrollment does.
    expect(labels(el)).toContain(`Stop mirroring`);
});

// Ends a pairing only a fresh one-liner remakes, so it asks first and goes to the machine, which self-revokes.
it(`asks before unpairing, then tells the machine to do it`, async () => {
    const el = mount([mirrored(`on`)]);
    await openRow(el, `work`);
    [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).trim() === `Unpair`)?.click();
    await nextTick();
    expect(mirrorCalls).toEqual([]);
    expect(document.body.textContent ?? ``).toContain(`stops syncing this sandbox's files`);

    // The last match is the dialog's own button; it teleports to the end of <body>.
    [...document.body.querySelectorAll(`button`)].findLast((control) => (control.textContent ?? ``).trim() === `Unpair`)?.click();
    await nextTick();
    expect(mirrorCalls).toEqual([{ hostId: `host-1`, command: `sync-unpair`, sandboxId: `work-abc` }]);
});

// Replaces a button that used to revoke every paired device at once.
it(`revokes one device's access, naming that machine alone`, async () => {
    const el = mount([mirrored(`on`)]);
    [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).includes(`Revoke access`))?.click();
    await nextTick();
    expect(revokeCalls).toEqual([]);
    expect(document.body.textContent ?? ``).toContain(`every other paired device keeps syncing`);

    // The dialog's own confirm, which teleports past the row's button that opened it.
    [...document.body.querySelectorAll(`button`)].findLast((control) => (control.textContent ?? ``).includes(`Revoke access`))?.click();
    await nextTick();
    expect(revokeCalls).toEqual([`laptop`]);
});

// This is the sandbox's own door, so it's offered even on a machine this sandbox can't reach at all.
it(`offers to revoke a device that has no connection to run commands on`, () => {
    const el = mount([mirrored(`off`, null)]);
    expect(labels(el)).toContain(`Revoke access`);
    expect(labels(el)).not.toContain(`Unpair`);
});

// Owner-only, matching the daemon's floor: a member only ever drops their own mirror enrollment.
it(`does not offer the revoke to a member`, () => {
    owner.value = false;
    expect(labels(mount([mirrored(`on`)]))).not.toContain(`Revoke access`);
});

it(`says nothing about revoking a device that is not enrolled for sync`, () => {
    expect(labels(mount([managed(true)]))).not.toContain(`Revoke access`);
});

// These answer "I'm working on something else on this laptop": the same two commands as the pairing switches,
// run bare.

// Two pairings, so "every sandbox this machine pairs" is a claim with something in it.
const twoPairings = (first: Partial<Record<string, unknown>> = {}, second: Partial<Record<string, unknown>> = {}): Device => ({
    key: `rog`,
    label: `radarsu-rog`,
    sync: paired(),
    platform: `linux`,
    hostId: `host-1`,
    online: true,
    report: {
        hostname: `radarsu-rog`,
        os: `linux`,
        sandboxes: [],
        pairings: [
            { sandboxId: `work-a`, mode: `sync`, localDir: `/home/ada/a`, mutagenStatus: `watching`, ...first },
            { sandboxId: `work-b`, mode: `sync`, localDir: `/home/ada/b`, mutagenStatus: `watching`, ...second },
        ],
        ports: [],
        agent: { running: true, installed: `1.183.0` },
        capturedAt: Date.now(),
    },
});

it(`pauses file syncing for every sandbox on the device, with no sandbox named`, async () => {
    const el = mount([twoPairings()]);
    [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).trim() === `Pause all`)?.click();
    await nextTick();
    expect(mirrorCalls).toEqual([{ hostId: `host-1`, command: `sync-pause`, sandboxId: undefined }]);
});

it(`stops port mirroring for every sandbox on the device`, async () => {
    const el = mount([twoPairings()]);
    [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).trim() === `Stop all`)?.click();
    await nextTick();
    expect(mirrorCalls).toEqual([{ hostId: `host-1`, command: `mirror-off`, sandboxId: undefined }]);
});

// A settled switch points the way out of where it is, the same rule the per-pairing buttons follow.
it(`points each switch whichever way the machine currently says`, () => {
    const el = mount([twoPairings({ paused: true, mirroring: `off` }, { paused: true, mirroring: `off` })]);
    const found = labels(el);
    expect(found).toContain(`Resume all`);
    expect(found).toContain(`Start all`);
    expect(found).not.toContain(`Pause all`);
    expect(found).not.toContain(`Stop all`);
    expect(el.textContent ?? ``).toContain(`paused`);
});

// Per-pairing switches can leave a machine mixed; a single button would silently undo half of what was
// deliberately set differently.
it(`says which pairings disagree and offers both directions`, () => {
    const el = mount([twoPairings({ mirroring: `off` }, { mirroring: `on` })]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`1 of 2 off`);
    expect(labels(el)).toContain(`Start all`);
    expect(labels(el)).toContain(`Stop all`);
});

// A mirror enrollment has no session to pause, so it's never counted toward the file-sync switch.
it(`draws no file-sync switch on a device that only mirrors ports`, () => {
    const row = mirrorOnly();
    const el = mount([
        {
            ...row,
            hostId: `host-1`,
            online: true,
            report: {
                ...row.report!,
                pairings: [
                    { sandboxId: `work-abc`, mode: `mirror` },
                    { sandboxId: `other-abc`, mode: `mirror` },
                ],
            },
        },
    ]);
    const found = labels(el);
    expect(found).not.toContain(`Pause all`);
    expect(found).not.toContain(`Resume all`);
    expect(found).toContain(`Stop all`);
});

// Over a single pairing these buttons would run the same command as that row's own, twenty pixels away, under
// a wider and scarier label.
it(`drops the device-scoped switches over a single pairing, and counts them above one`, () => {
    const one = labels(mount([{ ...mirrorOnly(), hostId: `host-1`, online: true }]));
    expect(one).not.toContain(`Stop all`);
    expect(one).toContain(`Revoke access`);

    const el = mount([twoPairings()]);
    expect(labels(el)).toContain(`Stop all`);
    expect(el.textContent ?? ``).toContain(`all 2 sandboxes`);
});

it(`states the halves without offering the switches on a device it cannot run commands on`, () => {
    const row = twoPairings();
    const found = labels(mount([{ ...row, hostId: undefined, online: undefined }]));
    expect(found).not.toContain(`Pause all`);
    expect(found).not.toContain(`Stop all`);
});

it(`draws no switches on a connected device with no pairings`, () => {
    expect(labels(mount([managed(true)]))).not.toContain(`Stop all`);
});
