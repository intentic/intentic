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
 * the address the code names and its boot. Returns false for a code the platform never minted.
 */
export const redeem = (code: string): boolean => {
    const minted = codeOf(code);
    if (minted === undefined) {
        return false;
    }
    const { sandboxId, hostname } = minted;
    // Still the row's current code, and the row still there: a newer mint or a delete ends the run where it stands.
    const current = (): boolean => rowOf(sandboxId) !== undefined && latestCodeFor(sandboxId) === code;
    pace([
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
    ]);
    return true;
};

/** The words `ic sandbox connect` prints on the machine, as the Devices flow streams them back. */
export const connectLines = (slug: string, code: string): string[] => {
    const host = codeOf(code)?.hostname ?? sandboxHostname();
    return [
        `intentic: redeeming setup code ${code.slice(0, 7)}… with the platform`,
        `intentic: pulling ghcr.io/intentic/sandbox:stable…`,
        `stable: Pulling from intentic/sandbox`,
        `Digest: sha256:1366a71da67cabd5d9f5c90d3b3a4181d861c7b29decc57cc0201c546317ab60`,
        `intentic: creating the tunnel for ${host}`,
        `intentic: starting intentic-sandbox-${slug}`,
        `intentic: waiting for the sandbox daemon to answer…`,
        `intentic: sandbox ${slug} is up at https://${host}`,
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
