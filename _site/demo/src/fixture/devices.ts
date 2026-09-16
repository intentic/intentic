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

const AGENT = { running: true, pid: 48211, build: `1.275.0`, installed: `1.275.0` };

export const demoDevices = (now: number): Device[] => [
    {
        key: `ada-pc`,
        label: `ada-pc`,
        hostId: `ada-pc`,
        online: true,
        platform: `windows`,
        agentVersion: `1.275.0`,
        lastSeen: now - 4_000,
        facts: { hostname: `ada-pc`, os: `windows`, arch: `x64`, shell: `pwsh`, home: `C:\\Users\\ada`, roots: [`C:\\Users\\ada`], wslDistros: [`archlinux`] },
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
        // holding the folder — which is what decides where a sync button is sent.
        key: `ada-pc`,
        label: `Arch Linux`,
        hostId: `ada-pc-arch`,
        online: true,
        platform: `linux`,
        agentVersion: `1.275.0`,
        lastSeen: now - 3_000,
        facts: { hostname: `ada-pc`, os: `linux`, arch: `x64`, shell: `/usr/bin/zsh`, home: `/home/ada`, roots: [`/home/ada`], wsl: { distro: `archlinux` } },
        report: {
            hostname: `ada-pc`,
            os: `linux`,
            wsl: { distro: `archlinux` },
            pairings: [PAIRING],
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
