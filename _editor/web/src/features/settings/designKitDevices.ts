import { type AgentPanel, type DeviceFolderRow, type DevicePortRow, type DeviceSandboxRow, restartAgent } from "@intentic/ui";

// The design kit's device samples (DesignKit.vue's device panel section): sandboxes, folder pairings, ports and an agent
// loop shaped so every row state the panel draws is on screen at once.

// Two sandboxes cover every row state: run/stop, sync/halted, mirrored/contested port, both power states.
export const KIT_SANDBOXES: readonly DeviceSandboxRow[] = [
    // Only row with resources set: exercises the Share line and the privileged toggle drawn locked.
    {
        slug: `work`,
        name: `work`,
        running: true,
        image: `ghcr.io/intentic/sandbox:2.3.1`,
        tunnelRunning: true,
        resources: { memoryBytes: 12 * 1024 ** 3, cpus: 4, privileged: true, gpu: false, hostRuntime: [], overlayRuntime: [`--privileged`] },
    },
    { slug: `lab`, name: `lab`, running: false, image: `ghcr.io/intentic/sandbox:2.2.9`, tunnelRunning: false },
    { slug: `hold`, name: `hold`, running: true, image: `ghcr.io/intentic/sandbox:2.3.1`, tunnelRunning: true },
];
// Healthy rows state both sync and backup explicitly; omitting one would misread as not backed up.
// Third row: mirroring off, no ports — an empty list also means a quiet sandbox, not a fault — and paused because the
// laptop's drive is nearly full, with one repo whose git history stopped following: the two holds the device sets itself.
export const KIT_PAIRINGS: readonly DeviceFolderRow[] = [
    { sandboxId: `work-intentic-dev`, mode: `sync`, localDir: `/home/ada/intentic/work`, mutagenStatus: `watching`, backupStatus: `watching` },
    // The conflict shape this product actually produces, and the one it produces most: an agent moved package
    // directories in the sandbox, and each is held here by build output nothing syncs — beside one real disagreement,
    // since a folder carrying both is what makes the two sentences have to coexist.
    {
        sandboxId: `lab-intentic-dev`,
        mode: `sync`,
        localDir: `/home/ada/intentic/lab`,
        mutagenStatus: `halted-on-root-emptied`,
        conflicts: 3,
        conflictedPaths: [
            { path: `packages/acceptance`, local: `untracked`, sandbox: `deleted`, nature: `derived-leftover` },
            { path: `packages/deployments`, local: `untracked`, sandbox: `deleted`, nature: `derived-leftover` },
            { path: `src/pricing/CheckoutPanel.tsx`, local: `modified`, sandbox: `modified`, nature: `both-edited` },
        ],
    },
    {
        sandboxId: `hold-intentic-dev`,
        mode: `sync`,
        localDir: `/home/ada/intentic/hold`,
        mutagenStatus: `watching`,
        backupStatus: `watching`,
        mirroring: `off`,
        paused: true,
        lowDisk: { freeBytes: 3.1 * 1024 ** 3, totalBytes: 953 * 1024 ** 3 },
        bridgeHolds: [{ repo: `firma-backup`, reason: `stalled`, retryAt: Date.UTC(2026, 9, 18, 21, 40) }],
    },
];
// Several ports, not one: a wrapping row of chips is the layout that actually broke.
export const KIT_PORTS: readonly DevicePortRow[] = [
    { port: 5173, sandboxId: `work-intentic-dev`, state: `mirrored`, command: `/usr/bin/node /work/node_modules/.bin/vite` },
    { port: 33177, sandboxId: `work-intentic-dev`, state: `mirrored`, command: `/usr/bin/node /work/backend-host-main.js` },
    { port: 33679, sandboxId: `work-intentic-dev`, state: `mirrored`, command: `node main.js` },
    { port: 6379, sandboxId: `work-intentic-dev`, state: `busy`, command: `/usr/bin/docker-proxy -proto tcp -host-port 6379` },
    // The one outcome somebody chose, which is why it wears quiet ink while the two beside it wear a warning's.
    { port: 5440, sandboxId: `work-intentic-dev`, state: `ignored`, command: `postgres` },
    { port: 5173, sandboxId: `lab-intentic-dev`, state: `held-by-sandbox`, heldBy: `work-intentic-dev`, command: `node vite` },
];
// A healthy loop with both verbs offered: the standing case, where the quiet note is what makes the buttons legible.
export const KIT_AGENT: AgentPanel = {
    version: `1.275.0`,
    state: { word: `running`, variant: `success` },
    facts: [`pid 12716`],
    notes: [{ text: `Newest agent this sandbox knows of.`, icon: `check-circle` }],
    actions: [
        { op: `upgrade`, label: `Update agent`, hint: `Fetches the newest agent onto this device, installs it, and restarts its loop.` },
        restartAgent(),
    ],
    blocked: undefined,
};
