import type { Device } from "@intentic/sandbox-contract";

// One of the owner's own computers, as the daemon's device registry reports it. The Devices tab used to answer
// "the demo fixture doesn't serve GET /system/devices", so every control under a paired folder — pause, unpair,
// mirroring, and the two that answer a conflict — could only be read in the source.
//
// A Windows PC with a distro on it, which is the shape that exercises the most: two environments of one machine,
// the folder on the Linux side, and the buttons routed by which side holds it.

const HOUR = 3_600_000;

// A REAL WEDGE, not a tidy one. Two package directories an agent moved in the sandbox, each still here because
// build output nothing syncs is sitting inside it — and beside them one file both ends edited, which is the only
// one of the three a person has to decide. A folder carrying both is what makes the card say two things at once.
const PAIRING: NonNullable<Device[`report`]>[`pairings`][number] = {
    sandboxId: `demo`,
    mode: `sync`,
    localDir: `/home/ada/intentic/acme-shop`,
    mirroring: `on`,
    mutagenStatus: `watching`,
    backupStatus: `watching`,
    conflicts: 3,
    conflictedPaths: [
        { path: `packages/acceptance`, local: `untracked`, sandbox: `deleted`, nature: `derived-leftover` },
        { path: `packages/deployments`, local: `untracked`, sandbox: `deleted`, nature: `derived-leftover` },
        { path: `src/pricing/CheckoutPanel.tsx`, local: `modified`, sandbox: `modified`, nature: `both-edited` },
    ],
};

// The other half of what a machine actually holds: a sandbox it keeps the files of and does not run — one living
// somewhere else, or one already gone. A PC collects these, and the list is only worth pruning because they pile up.
const SYNCED_ELSEWHERE: NonNullable<Device[`report`]>[`pairings`][number] = {
    sandboxId: `billing-api`,
    mode: `sync`,
    localDir: `/home/ada/intentic/billing-api`,
    mirroring: `on`,
    mutagenStatus: `watching`,
    backupStatus: `watching`,
    paused: true,
};

const AGENT = { running: true, pid: 48211, build: `1.275.0`, installed: `1.275.0` };

// The containers this PC's docker actually runs. Without these the fixture served a machine that hosts nothing, so
// every surface built on "which machine runs this sandbox" — the Devices row's Resources… form, the Resources row on
// Overview, the raise offered on an out-of-memory refusal — drew nothing and could only be read in the source.
// `sandbox` is the slug the demo daemon's own origin gives (DEMO_DAEMON_ORIGIN, `sandbox.demo.invalid`), which is
// what makes this the sandbox serving the page rather than a stranger's; the second is a sibling, for the rows that
// have to look different from the self row.
const ENGINE = { memoryBytes: 32 * 1024 ** 3, cpus: 16 };
const GIB = 1024 ** 3;
const SANDBOXES: NonNullable<Device[`sandboxes`]> = [
    {
        slug: `sandbox`,
        container: `intentic-sandbox-sandbox`,
        running: true,
        image: `ghcr.io/intentic/sandbox:latest`,
        tunnelRunning: true,
        // Capped well under the engine's size, so a raise has somewhere to go: the offer withdraws itself once the
        // cap reaches everything the engine has.
        resources: { memoryBytes: 16 * GIB, cpus: 8, privileged: true, gpu: false, hostRuntime: [`--privileged`], overlayRuntime: [] },
    },
    {
        slug: `billing-api`,
        container: `intentic-sandbox-billing-api`,
        running: false,
        image: `ghcr.io/intentic/sandbox:latest`,
        resources: { memoryBytes: 8 * GIB, privileged: false, gpu: false, hostRuntime: [], overlayRuntime: [] },
    },
];

export const demoDevices = (now: number): Device[] => [
    {
        key: `ada-pc`,
        label: `ada-pc`,
        hostId: `ada-pc`,
        online: true,
        platform: `windows`,
        agentVersion: `1.275.0`,
        lastSeen: now - 4_000,
        // `facts.os` is the OS's own name for itself, which is what a row's title is drawn from; the platform slug
        // lives in `platform` beside it.
        facts: {
            hostname: `ada-pc`,
            os: `Microsoft Windows 11 Home`,
            arch: `x64`,
            shell: `pwsh`,
            home: `C:\\Users\\ada`,
            roots: [`C:\\Users\\ada`],
            wslDistros: [`archlinux`],
            engine: ENGINE,
        },
        sandboxes: SANDBOXES,
        report: {
            hostname: `ada-pc`,
            os: `win32`,
            pairings: [],
            ports: [],
            agent: AGENT,
            capturedAt: now - 4_000,
        },
    },
    {
        // The distro of that same PC: same hostname, so the two fold into one machine, and this is the side
        // holding the folder — which is what decides where a sync button is sent. Its door is a connection of the
        // PC's card (`<card>::wsl:<distro>`), the shape the daemon addresses an environment by.
        key: `ada-pc:wsl`,
        label: `Arch Linux`,
        hostId: `ada-pc::wsl:archlinux`,
        online: true,
        platform: `linux`,
        agentVersion: `1.275.0`,
        lastSeen: now - 3_000,
        // One Docker engine serves a PC and every distro on it, so this side answers for the same containers and
        // reports the same engine; `hostRunningSandbox` picking either door is correct, not a conflict.
        facts: {
            hostname: `ada-pc`,
            os: `Arch Linux`,
            arch: `x64`,
            shell: `/usr/bin/zsh`,
            home: `/home/ada`,
            roots: [`/home/ada`],
            wsl: { distro: `archlinux` },
            engine: ENGINE,
        },
        sandboxes: SANDBOXES,
        report: {
            hostname: `ada-pc`,
            os: `linux`,
            wsl: { distro: `archlinux` },
            pairings: [PAIRING, SYNCED_ELSEWHERE],
            ports: [
                { port: 5173, host: `127.0.0.1`, sandboxId: `demo`, state: `mirrored`, command: `node vite` },
                { port: 6379, host: `127.0.0.1`, sandboxId: `demo`, state: `busy`, command: `docker-proxy` },
            ],
            agent: AGENT,
            capturedAt: now - 3_000,
        },
    },
    {
        // A machine seen a while ago and not answering now: the row that must stay readable with every button gone.
        key: `ada-air`,
        label: `ada-air`,
        hostId: `ada-air`,
        online: false,
        platform: `darwin`,
        agentVersion: `1.271.0`,
        lastSeen: now - 6 * HOUR,
        facts: { hostname: `ada-air`, os: `darwin`, arch: `arm64`, shell: `/bin/zsh`, home: `/Users/ada`, roots: [`/Users/ada`] },
    },
];
