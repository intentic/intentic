import type { HostedStatus, SetupReport } from "@intentic/api-contract";
import { checkIn, claimCode, codeOf, latestCodeFor, placeHosted, reportBoot, reportSetup, rowOf, sandboxHostname } from "./sandboxRegistry";

// THE MACHINES BEHIND THE ACCOUNT'S SANDBOXES, played: what a computer does once it holds a setup code (redeems it, pulls
// the image, opens the tunnel, starts the daemon, which announces itself), and what a machine of ours does once the
// platform provisions one (created, starting, started, the daemon's boot chain converging). Each step writes the same
// fields of the row a real run makes the platform write (world/sandboxRegistry.ts), paced so the editor's wait cards can be
// watched rather than skipped, which is how its registry watch (features/setup/flow/useRegistryWatch.ts) sees it.

// Between two stages of a setup run, and between two steps of a boot.
const STEP_MS = 1_100;
// How long the command lane waits before the "server" runs the pasted command: long enough to read the card that says
// what to do with it, short enough that the rest of the setup is seen.
const COMMAND_RUN_AFTER_MS = 9_000;

const STAGES: readonly SetupReport[`stage`][] = [`preflight`, `pulling-image`, `creating-tunnel`, `starting-sandbox`, `starting-connector`, `waiting-health`, `verifying`];

// A paced list of steps, each run once, in order; a step answering false stops the rest (the row went, a newer code).
const pace = (steps: readonly (() => boolean | void)[], every = STEP_MS): void => {
    const next = (index: number): void => {
        const step = steps[index];
        if (step === undefined || step() === false) {
            return;
        }
        setTimeout(() => next(index + 1), every);
    };
    next(0);
};

// The daemon's own boot after its first check-in: probing its address, then its chain converging to ready.
const BOOT_STEPS = [`Opening the workspace`, `Starting the agent runtime`, `Indexing the workspace`];
const bootSteps = (sandboxId: string): (() => boolean)[] => [
    ...BOOT_STEPS.map((step, done) => () => {
        reportBoot(sandboxId, { reach: `checking`, boot: { ready: false, step, done, total: BOOT_STEPS.length } });
        return rowOf(sandboxId) !== undefined;
    }),
    () => {
        reportBoot(sandboxId, { reach: `reachable`, boot: { ready: true, done: BOOT_STEPS.length, total: BOOT_STEPS.length } });
        return true;
    },
];

/**
 * A computer runs `ic sandbox connect` with this code: the claim, each stage of the run, then the daemon's check-in at
 * the address the code names and its boot, a step every `every` ms. Returns false for a code the platform never minted.
 */
export const redeem = (code: string, every = STEP_MS): boolean => {
    const minted = codeOf(code);
    if (minted === undefined) {
        return false;
    }
    const { sandboxId, hostname } = minted;
    // Still the row's current code, and the row still there: a newer mint or a delete ends the run where it stands.
    const current = (): boolean => rowOf(sandboxId) !== undefined && latestCodeFor(sandboxId) === code;
    pace(
        [
            () => {
                claimCode(sandboxId);
                return current();
            },
            ...STAGES.map((stage) => () => {
                reportSetup(sandboxId, stage);
                return current();
            }),
            () => {
                reportSetup(sandboxId, `done`);
                checkIn(sandboxId, `https://${hostname}`);
                return current();
            },
            ...bootSteps(sandboxId),
        ],
        every,
    );
    return true;
};

/** How many of `redeem`'s steps pass between the claim and the daemon's check-in, the moment the editor opens it. */
export const STEPS_TO_CHECK_IN = STAGES.length + 1;

/** One line `ic sandbox connect` prints, with the pause before it; `claims` marks the line the code is redeemed at. */
export interface ConnectLine {
    readonly text: string;
    readonly afterMs: number;
    readonly claims?: true;
}

// The image's layers as docker's pull names them, each pulled, downloaded and extracted in turn.
const IMAGE_LAYERS = [`3f4ca61aafcd`, `9b3a2e4c11d0`, `d5c0f2a8e771`, `5e1b0c9d2f44`, `a07c6d3e8b19`, `c81f0e2d4a96`];

/**
 * What `ic sandbox connect` prints on the machine, as the Devices flow streams it back and Add sandbox's progress reads it:
 * a `[phase]` marker per step of the plan (`@intentic/sandbox-run` setup-progress.ts), docker's own pull lines under the
 * download, paced so each step is seen to start and finish, about fourteen seconds in all.
 */
export const connectLines = (slug: string, code: string): ConnectLine[] => {
    const host = codeOf(code)?.hostname ?? sandboxHostname();
    return [
        { text: `intentic: [checking-docker] checking that Docker is running`, afterMs: 300 },
        { text: `Docker 27.3.1 is running`, afterMs: 700 },
        { text: `intentic: [preflight] checking disk space, memory and ports`, afterMs: 500 },
        { text: `48 GB free · 32 GB memory · ports free`, afterMs: 700 },
        { text: `intentic: [claiming-code] redeeming setup code ${code.slice(0, 7)}… with the platform`, afterMs: 500, claims: true },
        { text: `intentic: [pulling-image] pulling ghcr.io/intentic/sandbox:stable`, afterMs: 900 },
        { text: `stable: Pulling from intentic/sandbox`, afterMs: 300 },
        ...IMAGE_LAYERS.map((layer) => ({ text: `${layer}: Pulling fs layer`, afterMs: 80 })),
        ...IMAGE_LAYERS.flatMap((layer) => [
            { text: `${layer}: Downloading`, afterMs: 250 },
            { text: `${layer}: Download complete`, afterMs: 350 },
        ]),
        ...IMAGE_LAYERS.map((layer) => ({ text: `${layer}: Pull complete`, afterMs: 180 })),
        { text: `Digest: sha256:1366a71da67cabd5d9f5c90d3b3a4181d861c7b29decc57cc0201c546317ab60`, afterMs: 200 },
        { text: `Status: Downloaded newer image for ghcr.io/intentic/sandbox:stable`, afterMs: 200 },
        { text: `intentic: [starting-sandbox] starting intentic-sandbox-${slug}`, afterMs: 500 },
        { text: `intentic: [waiting-health] waiting for the sandbox daemon to answer`, afterMs: 1_000 },
        { text: `intentic: [verifying] checking https://${host} answers`, afterMs: 1_400 },
        { text: `intentic: [connecting-machine] connecting this computer to the sandbox`, afterMs: 900 },
        { text: `intentic: sandbox ${slug} is up at https://${host}`, afterMs: 1_100 },
    ];
};

/**
 * The command lane: nobody can paste a command into a server from a web page, so the demo's server runs it a few
 * seconds after the code is minted, unless a machine already redeemed it (the connected-machine lane) or a newer code
 * replaced it by then.
 */
export const runCommandLater = (code: string): void => {
    setTimeout(() => {
        const minted = codeOf(code);
        if (minted === undefined || latestCodeFor(minted.sandboxId) !== code || rowOf(minted.sandboxId)?.setupCodeClaimedAt !== null) {
            return;
        }
        redeem(code);
    }, COMMAND_RUN_AFTER_MS);
};

// What the provider says each machine of ours is doing, by row: the hosted wait polls it (sandbox.hostedStatus).
const power = new Map<string, HostedStatus[`machine`]>();

export const hostedPower = (sandboxId: string): HostedStatus[`machine`] => power.get(sandboxId) ?? (rowOf(sandboxId)?.hosted === null ? `gone` : `started`);

/**
 * sandbox.hostedProvision: a warm machine from the pool is created and started, its daemon announces at its address and
 * converges, and the row's placement reads awake once it is ready.
 */
export const provisionHosted = (sandboxId: string): void => {
    const hostname = sandboxHostname();
    power.set(sandboxId, `created`);
    placeHosted(sandboxId, { state: `starting`, region: `arn`, warm: true, canRollBack: false });
    pace([
        () => {
            power.set(sandboxId, `starting`);
            return rowOf(sandboxId) !== undefined;
        },
        () => {
            power.set(sandboxId, `started`);
            checkIn(sandboxId, `https://${hostname}`);
            return rowOf(sandboxId) !== undefined;
        },
        ...bootSteps(sandboxId),
        () => {
            placeHosted(sandboxId, { state: `awake`, region: `arn`, warm: true, canRollBack: false });
        },
    ]);
};

/** sandbox.hostedRelease: the machine goes back to the pool and the row is an own-machine sandbox again. */
export const releaseHosted = (sandboxId: string): void => {
    power.set(sandboxId, `destroyed`);
    placeHosted(sandboxId, null);
};

/** sandbox.wake / hostedRestart: an asleep or stopped machine of ours starts again. */
export const wakeHosted = (sandboxId: string): void => {
    if (rowOf(sandboxId)?.hosted === null) {
        return;
    }
    power.set(sandboxId, `starting`);
    pace([
        () => {
            placeHosted(sandboxId, { state: `starting`, region: `arn`, warm: true, canRollBack: false });
            return rowOf(sandboxId) !== undefined;
        },
        () => {
            power.set(sandboxId, `started`);
            placeHosted(sandboxId, { state: `awake`, region: `arn`, warm: true, canRollBack: false });
        },
    ]);
};
