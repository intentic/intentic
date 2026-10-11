import { hostRunningSandbox } from "@intentic/sandbox-contract";
import { type DeviceSandboxResources, type DeviceSandboxRow, type EngineFacts, type NoticeModel, type ResourcesForm, runningShape } from "@intentic/ui";
import { computed, type ComputedRef } from "vue";
import { t } from "@intentic/ui/i18n";
import { canSetShape, type ShapeIntent, shapeFlow, shapeSevers, tooOldToSave } from "./shapeFlow";
import { manageDeviceSandbox, useDevices } from "./useDevices";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useOperation } from "../../../workbench/operations/operations";
import { expectRestart } from "../live/sandboxRestart";

// THE SANDBOX SERVING THIS PAGE, AS SOMETHING THE PAGE CAN RESIZE. The Devices tab can already reshape any
// container on any connected machine, but it reaches them through a machine the reader picked; the two surfaces that
// need this one — the Overview card and the out-of-memory notice in chat — have no machine in hand and are asking
// about the container they are running inside. One composable so both ask it identically, and so "can this be
// raised at all" is decided once rather than per caller. The reshape itself is one run in the operations ledger, for
// this sandbox, whichever of the two started it: the other one holds its button and shows the same refusal, and either
// one opened again mid-reshape finds it still going.

/** Everything the resources form needs about this sandbox, or the reason there is nothing to open it on. */
export interface SelfResources {
    /** The door a reshape travels; undefined when this machine is not a connected device. */
    readonly hostId: ComputedRef<string | undefined>;
    /** This container's slug out there, from the daemon's own hostname. */
    readonly slug: ComputedRef<string | undefined>;
    /** This container as its machine lists it, so a caller can reuse the kit's own `resourcesSummary`. */
    readonly row: ComputedRef<DeviceSandboxRow | undefined>;
    /** Its share as docker enforces it now; undefined until the machine has reported it. */
    readonly current: ComputedRef<DeviceSandboxResources | undefined>;
    /** The engine's size, the rails the caps run between; absent when the machine could not say. */
    readonly engine: ComputedRef<EngineFacts | undefined>;
    /** Whether a reshape could be sent at all: a reachable door, a slug, and a reported share to change. */
    readonly reshapable: ComputedRef<boolean>;
    /** Whether the machine's agent can have ic save a shape for the next restart; Save is not offered otherwise. */
    readonly canSave: ComputedRef<boolean>;
    /** True while an apply or a save is in flight, from whichever surface; both callers disable their control on it. */
    readonly applying: ComputedRef<boolean>;
    /** The last reshape's refusal, as the machine said it, until it is put away. */
    readonly failure: ComputedRef<NoticeModel | undefined>;
    /**
     * Restarts this sandbox onto the shape. Recreates the container, which takes this page's connection down with it —
     * the caller warns about that beforehand, and `manageDeviceSandbox` reads the dropped stream as the expected
     * ending rather than a failure. Never throws: a refusal lands in `failure`.
     */
    readonly apply: (shape: ResourcesForm) => Promise<void>;
    /**
     * Has ic save the shape for this sandbox's next restart (undefined forgets what is saved). The container is not
     * touched, so the machine's own sentence does arrive; a refusal lands in `failure`.
     */
    readonly save: (shape: ResourcesForm | undefined) => Promise<void>;
    readonly refetch: () => void;
}

// The slug docker knows this container by: the first label of the daemon's own hostname, the same derivation
// `deviceOps.ts` uses for the Devices tab's self-row and the setup CLI uses on the way in.
const slugOfDaemon = (daemonUrl: string | undefined): string | undefined => (daemonUrl === undefined ? undefined : new URL(daemonUrl).hostname.split(`.`)[0]);

// One key for reshaping the sandbox on screen, whichever surface asks; the ledger already files it per sandbox.
const RESHAPE = `devices/self/reshape`;

export function useSelfResources(): SelfResources {
    const { active, daemonUrl } = useSandbox();
    // No poll of its own: both callers sit beside surfaces that already hold this query, and a card drawing a cap
    // is not a reason to wake every connected laptop every ten seconds.
    const { devices, refetch } = useDevices({ poll: false });

    const slug = computed(() => slugOfDaemon(daemonUrl.value));
    const hostId = computed(() => hostRunningSandbox(devices.value, slug.value));
    // Read off the door that answered, not off any device carrying the slug: only a connected, online one reports
    // a share, and `hostRunningSandbox` already picked which door that is.
    const door = computed(() => devices.value.find((device) => device.hostId !== undefined && device.hostId === hostId.value));
    const row = computed(() => door.value?.sandboxes?.find((box) => box.slug === slug.value));
    const current = computed(() => row.value?.resources);
    const engine = computed(() => door.value?.facts?.engine);
    const canSave = computed(() => canSetShape(door.value?.facts));

    const reshape = useOperation<string>(RESHAPE);
    // A share the machine never reported leaves the form nothing to open on, so there is nothing to offer either.
    const reshapable = computed(() => hostId.value !== undefined && slug.value !== undefined && current.value !== undefined);

    const send = async (intent: ShapeIntent): Promise<void> => {
        const sendTo = hostId.value;
        const name = slug.value;
        const share = current.value;
        const sandbox = active.value?.id;
        const what = t(`sandbox.deviceOps.workingResources`, { name: active.value?.name ?? name ?? `` });
        const severs = shapeSevers(intent);
        await reshape.run({
            what,
            tag: severs ? `apply` : `save`,
            failed: t(`sandbox.useSelfResources.didntWork`),
            task: async () => {
                if (sendTo === undefined || name === undefined || share === undefined) {
                    throw new Error(t(`sandbox.useSelfResources.notConnected`));
                }
                const { op, payload } = shapeFlow(intent, canSave.value, runningShape(share), tooOldToSave(door.value?.facts));
                // Applying replaces the container serving this page, so the silence it causes is said to be this, by
                // every surface, rather than read as a fault. Armed before the ask: the machine can take the sandbox
                // down before the stream settles.
                const restart =
                    severs && sandbox !== undefined
                        ? {
                              sandbox,
                              id: `recreate` as const,
                              what,
                              quiet: { title: what, detail: t(`ui.sandboxResourcesDialog.applyingRestartsSandboxOnto`) },
                          }
                        : undefined;
                const settle = restart === undefined ? undefined : expectRestart(restart);
                try {
                    // `severing`: applying recreates the container, and the daemon relaying this call lives in it, so no
                    // result frame can arrive. Without this the drop reads as a failure on a reshape that worked. A save
                    // touches nothing, so its answer does arrive.
                    const said = await manageDeviceSandbox(sendTo, name, op, { ...payload, severing: severs });
                    // The ask went through; the restart ends when the sandbox answers again, not when the stream did.
                    if (restart !== undefined) {
                        expectRestart({ ...restart, untilAnswered: true });
                    }
                    return said;
                } finally {
                    settle?.();
                    refetch();
                }
            },
        });
    };
    const apply = (shape: ResourcesForm): Promise<void> => send({ shape, when: `now` });
    const save = (shape: ResourcesForm | undefined): Promise<void> => send(shape === undefined ? { forget: true } : { shape, when: `nextRestart` });

    return {
        hostId,
        slug,
        row,
        current,
        engine,
        canSave,
        reshapable,
        applying: reshape.busy,
        failure: reshape.failure,
        apply,
        save,
        refetch,
    };
}
