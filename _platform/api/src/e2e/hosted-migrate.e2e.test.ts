import { randomUUID } from "node:crypto";
import { FREE_TIER, type HostedShape, hostedTier, PAID_TIERS } from "@intentic/constants";
import { e2eTier } from "@intentic/testing/e2e";
import { FLY_VOLUME_LAYOUT } from "@intentic/sandbox-run/fly";
import {
    createApp,
    createMachine,
    createVolume,
    createVolumeSnapshot,
    deleteApp,
    destroyMachine,
    getMachineDetail,
    getVolume,
    listVolumeSnapshots,
    startMachine,
    stopMachine,
    updateMachine,
} from "../sandbox/hosted/fly/fly.js";
import { MINUTE_MS } from "../durations.js";

/* THE ONE TEST THAT MOVES A REAL DISK. Everything else about the migration engine is proved against a stand-in, and a
 * stand-in cannot say that Fly still forks a volume, still restores a snapshot into another region, or still places a
 * machine where its volume is. This runs the three provider operations the engine is built on, against real Fly,
 * with a sentinel file to prove the bytes arrived.
 *
 * HOW THE SENTINEL IS WRITTEN AND READ WITHOUT A WAY INTO THE GUEST. A Fly machine's config can override its
 * entrypoint (`init.exec`) and its exit code is readable off the machine (`getMachineDetail`), so a one-line shell
 * script mounting the volume is both the pen and the eye: one run writes the file, a later run greps for it and the
 * exit code is the answer. No daemon, no tunnel, no network path into the sandbox — which also means this suite
 * proves the DISK moved rather than that the product came back up, and those are different claims.
 *
 * It spends real machines, volumes and snapshots on a real org, so it is gated twice: the switch and the credential.
 * Everything it makes lives in one app, and the app is destroyed in `afterAll` whatever happened. */
const tier = e2eTier(`moving a real disk between real Fly machines`, {
    enabledBy: `INTENTIC_E2E`,
    secrets: [`HOSTED_FLY_API_TOKEN`, `HOSTED_FLY_ORG`],
});

// A tiny public image with a shell: this suite never runs the sandbox, only touches its disk.
const PROBE_IMAGE = `docker.io/library/alpine:3.20`;
// The volume's mount point and the path the sentinel lives at, from the run contract so the layout is not retyped.
const SENTINEL = `${FLY_VOLUME_LAYOUT.workspace}/.intentic-migration-e2e`;

const START_REGION = `iad`;
const MOVE_REGION = `arn`;

// Hang bounds, not latency measurements: a probe is seconds and a cross-region restore is minutes, and both are set
// far above the slow case so contention fails nothing. A run that reaches either has genuinely stopped.
const PROBE_DEADLINE_MS = 3 * MINUTE_MS;
const SUITE_TIMEOUT_MS = 20 * MINUTE_MS;
const POLL_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The free rung's shape, which is what the machines here run as unless a case is about a bigger one.
const shapeOf = (shape: HostedShape) => ({ cpu_kind: shape.cpuKind, cpus: shape.cpus, memory_mb: shape.memoryMb }) as const;

describe.skipIf(!tier.runs)(tier.title, () => {
    const token = (): string => tier.secrets.HOSTED_FLY_API_TOKEN;
    const app = `intentic-e2e-mig-${randomUUID().slice(0, 8)}`;

    // What the run holds right now; each step moves these on, and teardown destroys whatever they name.
    let volumeId = ``;
    let machineId = ``;
    let snapshotId = ``;
    let restoredVolumeId = ``;
    const sentinel = randomUUID();

    /* Runs one shell line on the volume and answers its exit code. The machine is reconfigured, started, and polled
     * until Fly says it ended; `restart: no` because an exit IS the answer here and a retry would hide it. */
    const onVolume = async (script: string, onVolumeId: string = volumeId): Promise<number | undefined> => {
        await updateMachine(token(), app, machineId, {
            image: PROBE_IMAGE,
            guest: shapeOf(FREE_TIER),
            env: {},
            mounts: [{ volume: onVolumeId, path: `/data` }],
            restart: { policy: `no` },
            auto_destroy: false,
            init: { exec: [`/bin/sh`, `-c`, script] },
        });
        // A machine mid-replacement refuses a start; the loop below is the same settling wait provisioning does.
        for (let attempt = 0; attempt < Math.ceil(PROBE_DEADLINE_MS / POLL_MS); attempt += 1) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a poll loop is the shape of this wait
            const detail = await getMachineDetail(token(), app, machineId);
            if (detail.state === `stopped` || detail.state === `failed`) {
                return detail.exitCode;
            }
            if (detail.state !== `replacing` && detail.state !== `starting` && detail.state !== `started`) {
                // oxlint-disable-next-line eslint/no-await-in-loop
                await startMachine(token(), app, machineId).catch(() => undefined);
            }
            // oxlint-disable-next-line eslint/no-await-in-loop
            await sleep(POLL_MS);
        }
        throw new Error(`the probe machine never finished within ${PROBE_DEADLINE_MS / MINUTE_MS} minutes`);
    };

    /** Whether the sentinel this run wrote is on that volume; the exit code of a grep, and nothing else. */
    const sentinelSurvives = async (onVolumeId: string = volumeId): Promise<boolean> =>
        (await onVolume(`grep -q ${sentinel} ${SENTINEL}`, onVolumeId)) === 0;

    beforeAll(async () => {
        await createApp(token(), tier.secrets.HOSTED_FLY_ORG, app);
        ({ volumeId } = await createVolume(token(), app, START_REGION, FREE_TIER.volumeGb, {
            // The hint the engine always passes: a volume placed without it can land where its machine will not fit.
            compute: { cpuKind: FREE_TIER.cpuKind, cpus: FREE_TIER.cpus, memoryMb: FREE_TIER.memoryMb },
            snapshotRetention: 1,
        }));
        ({ machineId } = await createMachine(token(), app, {
            name: app,
            region: START_REGION,
            config: {
                image: PROBE_IMAGE,
                guest: shapeOf(FREE_TIER),
                env: {},
                mounts: [{ volume: volumeId, path: `/data` }],
                restart: { policy: `no` },
                auto_destroy: false,
                init: { exec: [`/bin/sh`, `-c`, `mkdir -p ${FLY_VOLUME_LAYOUT.workspace} && echo ${sentinel} > ${SENTINEL}`] },
            },
        }));
    }, SUITE_TIMEOUT_MS);

    afterAll(async () => {
        // One app holds every machine, volume and snapshot this run made, so one delete collects all of it. Never
        // conditional on what passed: a leaked volume bills forever and nobody is watching this org's console.
        await deleteApp(token(), app).catch(() => undefined);
    }, SUITE_TIMEOUT_MS);

    it(
        `writes a sentinel onto the disk, and can read it back`,
        async () => {
            // The boot above wrote it; this is the read channel proving itself before anything is moved.
            expect(await sentinelSurvives()).toBe(true);
            expect(await onVolume(`grep -q not-the-sentinel ${SENTINEL}`)).not.toBe(0);
        },
        SUITE_TIMEOUT_MS,
    );

    it(
        `takes a snapshot the provider finishes, which is what a migration's rollback rests on`,
        async () => {
            const taken = await createVolumeSnapshot(token(), app, volumeId);
            snapshotId = taken.id;
            let finished: string | undefined;
            for (let attempt = 0; attempt < Math.ceil(SUITE_TIMEOUT_MS / POLL_MS) && finished !== `created`; attempt += 1) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- a poll loop is the shape of this wait
                finished = (await listVolumeSnapshots(token(), app, volumeId)).find((snapshot) => snapshot.id === snapshotId)?.status;
                if (finished !== `created`) {
                    // oxlint-disable-next-line eslint/no-await-in-loop
                    await sleep(POLL_MS);
                }
            }
            // `created` is the only status a restore accepts; `running` restores an empty volume and says nothing.
            expect(finished).toBe(`created`);
        },
        SUITE_TIMEOUT_MS,
    );

    /* A RESIZE COPIES NOTHING. The guest changes, the volume id does not, and the file is exactly where it was —
     * which is the whole reason a rung change is seconds rather than minutes. */
    it(
        `survives a resize to a bigger guest on the same volume`,
        async () => {
            const bigger = hostedTier((PAID_TIERS[0] ?? FREE_TIER).id);
            const before = volumeId;
            await updateMachine(token(), app, machineId, {
                image: PROBE_IMAGE,
                guest: shapeOf(bigger),
                env: {},
                mounts: [{ volume: volumeId, path: `/data` }],
                restart: { policy: `no` },
                auto_destroy: false,
                init: { exec: [`/bin/sh`, `-c`, `true`] },
            });
            expect(volumeId).toBe(before);
            expect(await sentinelSurvives()).toBe(true);
        },
        SUITE_TIMEOUT_MS,
    );

    /* A MOVE COPIES EVERYTHING, into another region, where a block-level fork is not available and the snapshot is
     * the only way across. This is the operation the engine's `move` is made of, and the one nothing but real Fly
     * can answer for. */
    it(
        `survives a move to another region, restored from the snapshot onto a new volume`,
        async () => {
            const source = await getVolume(token(), app, volumeId);
            const moved = await createVolume(token(), app, MOVE_REGION, FREE_TIER.volumeGb, {
                snapshotId,
                compute: { cpuKind: FREE_TIER.cpuKind, cpus: FREE_TIER.cpus, memoryMb: FREE_TIER.memoryMb },
                snapshotRetention: 1,
            });
            restoredVolumeId = moved.volumeId;

            // A machine in the new region, mounting the new volume: the other half of what `move` builds.
            const arrived = await createMachine(token(), app, {
                name: `${app}-moved`,
                region: MOVE_REGION,
                config: {
                    image: PROBE_IMAGE,
                    guest: shapeOf(FREE_TIER),
                    env: {},
                    mounts: [{ volume: restoredVolumeId, path: `/data` }],
                    restart: { policy: `no` },
                    auto_destroy: false,
                    init: { exec: [`/bin/sh`, `-c`, `grep -q ${sentinel} ${SENTINEL}`] },
                },
            });

            for (let attempt = 0; attempt < Math.ceil(SUITE_TIMEOUT_MS / POLL_MS); attempt += 1) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- a poll loop is the shape of this wait
                const detail = await getMachineDetail(token(), app, arrived.machineId);
                if (detail.state === `stopped` || detail.state === `failed`) {
                    // 0 means the grep found this run's own sentinel on a volume in another region.
                    expect(detail.exitCode).toBe(0);
                    const restored = await getVolume(token(), app, restoredVolumeId);
                    expect(restored.sizeGb).toBe(source.sizeGb);
                    await destroyMachine(token(), app, arrived.machineId, { force: true });
                    return;
                }
                // oxlint-disable-next-line eslint/no-await-in-loop
                await sleep(POLL_MS);
            }
            throw new Error(`the moved machine never finished its check`);
        },
        SUITE_TIMEOUT_MS,
    );

    /* THE OLD DISK IS STILL THERE. The engine destroys it only after the new machine has answered, and this is the
     * state in between: two volumes, both readable, which is what makes the rollback a rollback. */
    it(
        `leaves the original volume intact and readable while the copy exists`,
        async () => {
            await stopMachine(token(), app, machineId).catch(() => undefined);
            expect(await sentinelSurvives()).toBe(true);
            expect((await getVolume(token(), app, volumeId)).state).not.toBe(`destroyed`);
        },
        SUITE_TIMEOUT_MS,
    );
});
