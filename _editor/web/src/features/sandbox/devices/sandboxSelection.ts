import type { DeviceSandboxGroup } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, ref, type Ref } from "vue";
import { type BatchAction, batchable, batchActions, type MachineRow } from "./deviceRows";
import type { DeviceOps } from "./runners/deviceOps";

// SELECTING IS HOW THE LIST IS MANAGED. A tick box on every row and one bar above them (<SandboxBatchBar>): tick what
// you mean, and the bar offers only the verbs something ticked can take (deviceRows.ts `batchActions`), each saying how
// many rows it would act on. Every row keeps one quiet ⋯ for what only makes sense one at a time — its logs, its
// Resources… form — so the line itself carries no verbs at all. Kept out of the page, which only wires the ticks to
// the rows and the bar to the list.

export interface SandboxSelection {
    readonly picked: Ref<ReadonlySet<string>>;
    /** The ticked rows a batch may take, in the list's order. */
    readonly chosen: ComputedRef<readonly DeviceSandboxGroup[]>;
    readonly chosenIds: ComputedRef<readonly string[]>;
    // Drawn only over two or more rows: over one, the bar would be that row's own menu in a wider, scarier label.
    readonly selectable: ComputedRef<boolean>;
    readonly allPicked: ComputedRef<boolean>;
    readonly actions: ComputedRef<readonly BatchAction[]>;
    /** Why a row's box is dead, read from the rule rather than discovered by clicking it; undefined when it isn't. */
    readonly unpickable: (group: DeviceSandboxGroup) => string | undefined;
    readonly pick: (group: DeviceSandboxGroup, on: boolean) => void;
    readonly pickAll: (on: boolean) => void;
    readonly run: (action: BatchAction) => void;
    readonly confirmRemoval: () => void;
    readonly confirmBatch: () => void;
}

export function useSandboxSelection(machine: () => MachineRow, ownSlug: () => string | undefined, ops: DeviceOps): SandboxSelection {
    const picked = ref<ReadonlySet<string>>(new Set());
    // Never the sandbox serving this page (batchable): stopping or removing it would take the connection down mid-run
    // and abandon every row queued behind it. Its own ⋯ still does everything, and warns about exactly that.
    const pickable = computed(() => batchable(machine(), ownSlug()));
    const pickableIds = computed(() => new Set(pickable.value.map((group) => group.sandboxId)));
    // Filtered through what is pickable NOW, so a tick on a row that has since left names nothing.
    const chosen = computed(() => pickable.value.filter((group) => picked.value.has(group.sandboxId)));

    const unpickable = (group: DeviceSandboxGroup): string | undefined => {
        if (pickableIds.value.has(group.sandboxId)) {
            return undefined;
        }
        return ops.selfGroup(group) ? t(`sandbox.devicePage.cantPickSelf`) : t(`sandbox.devicePage.nothingToPick`);
    };

    const pick = (group: DeviceSandboxGroup, on: boolean): void => {
        const next = new Set(picked.value);
        if (on) {
            next.add(group.sandboxId);
        } else {
            next.delete(group.sandboxId);
        }
        picked.value = next;
    };

    const pickAll = (on: boolean): void => {
        picked.value = on ? new Set(pickableIds.value) : new Set();
    };

    // The ticks go with the press: what is left of them once rows start changing is a selection of rows that no longer
    // look like what was ticked, and the run's own answer already names what it did. A verb that asks first keeps them
    // until it is agreed to, so backing out of its dialog loses nothing.
    const run = (action: BatchAction): void => {
        ops.runBatch(action);
        if (action.verb !== `remove` && action.verb !== `update`) {
            pickAll(false);
        }
    };

    return {
        picked,
        chosen,
        chosenIds: computed(() => chosen.value.map((group) => group.sandboxId)),
        selectable: computed(() => pickable.value.length > 1),
        allPicked: computed(() => chosen.value.length > 0 && chosen.value.length === pickable.value.length),
        actions: computed(() => batchActions(machine(), chosen.value)),
        unpickable,
        pick,
        pickAll,
        run,
        confirmRemoval: () => {
            ops.confirmRemoval();
            pickAll(false);
        },
        confirmBatch: () => {
            ops.confirmBatch();
            pickAll(false);
        },
    };
}
