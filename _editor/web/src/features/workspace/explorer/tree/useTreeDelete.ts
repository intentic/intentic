import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { computed, type Ref, ref, watch } from "vue";
import type { useNotifications } from "../../../../shell/notifications/notifications";
import type { BarrenChain } from "../emptyDirs";
import type { DeleteBatch } from "../undo/deleteUndo";
import { deletedReceipt, joinPath } from "../entryNames";
import type { useEmptyDirs } from "../useEmptyDirs";
import type { useWorkspaceTree } from "../useWorkspaceTree";
import type { useTreeRules } from "./useTreeRules";
import type { MultiSelect } from "../../../../lib/multiSelect";

// Deleting from the tree, and the empty-folder sweep line. Neither asks first: a delete goes to the daemon's trash, and
// the receipt's Undo (or Mod+Z, anywhere in the workspace) puts back exactly what went. A confirm in front of an undo
// only makes the common case slower, and a drop that was the wrong file should leave as fast as it came.

// `where` is the ancestor path that is staying; `label` is the barren chain itself, about to be deleted. Kept apart,
// since a joined path could read as one folder being deleted when only the tail is.
export interface BarrenBranch {
    readonly path: string;
    readonly where: string;
    readonly label: string;
}

export const branchOf = (path: string, chainOf: (path: string) => BarrenChain): BarrenBranch => ({
    path,
    where: path.split(`/`).slice(0, -1).join(` / `),
    label: chainOf(path).names.join(` / `),
});

// What sweeping these branches says. Named before the delete, since the tree won't know the chain after.
export const sweepReceipt = (roots: readonly string[], chainOf: (path: string) => BarrenChain): string => {
    const [only] = roots;
    if (roots.length !== 1 || only === undefined) {
        return `${roots.length} empty folders removed`;
    }
    // The whole path in one string: a receipt has no room to shade the two parts differently.
    const branch = branchOf(only, chainOf);
    return `${branch.where === `` ? branch.label : `${branch.where} / ${branch.label}`} removed`;
};

// Sends `paths` to the daemon's trash and says so once it lands, the receipt's Undo taking back exactly that batch. The
// receipt is named by the caller while it still knows what went; every surface that deletes goes through here.
export const deleteEntries = (
    seams: { readonly store: Pick<ReturnType<typeof useWorkspaceTree>, "run" | "removeEntries">; readonly sayDeleted: (receipt: string, batch: DeleteBatch) => void },
    paths: readonly string[],
    receipt = deletedReceipt(paths),
): Promise<void> =>
    seams.store.run(async () => {
        const batch = await seams.store.removeEntries(paths);
        seams.sayDeleted(receipt, batch);
    }, `Couldn't delete that.`);

export interface TreeDeleteHost {
    readonly byPath: Readonly<Ref<ReadonlyMap<string, WorkspaceTreeEntry>>>;
    readonly targetDir: (path: string | null) => string;
    readonly rules: Pick<ReturnType<typeof useTreeRules>, "refuseIn" | "unlockedOnly">;
    readonly emptyDirs: ReturnType<typeof useEmptyDirs>;
    readonly selecting: Pick<MultiSelect, "selection" | "lead" | "clear">;
    readonly store: Pick<ReturnType<typeof useWorkspaceTree>, "run" | "removeEntries" | "createFile" | "refuseWrite">;
    readonly say: ReturnType<typeof useNotifications>["say"];
    // The receipt for a delete that landed, offering to take back exactly that batch.
    readonly sayDeleted: (receipt: string, batch: DeleteBatch) => void;
}

export const useTreeDelete = (host: TreeDeleteHost) => {
    const { store, emptyDirs, selecting } = host;

    const remove = (paths: readonly string[], receipt: string): void => {
        void deleteEntries(host, paths, receipt);
        selecting.clear();
    };
    const sweep = (roots: readonly string[]): void => {
        if (roots.length === 0 || store.refuseWrite()) {
            return;
        }
        remove(roots, sweepReceipt(roots, emptyDirs.chainOf));
    };
    // A barren-only selection reads as the sweep line does, since that is what it is.
    const requestDelete = (): void => {
        if (host.rules.refuseIn(host.targetDir(selecting.lead.value))) {
            return;
        }
        const paths = host.rules.unlockedOnly([...selecting.selection.value]);
        if (paths.length === 0) {
            return;
        }
        if (paths.every((path) => host.byPath.value.get(path)?.type === `dir` && emptyDirs.isBarren(path))) {
            sweep(paths);
            return;
        }
        remove(paths, deletedReceipt(paths));
    };
    // Drops a placeholder into the chain's deepest folder, making it non-empty for git and off the barren list for good.
    const keepFolder = async (path: string): Promise<void> => {
        if (host.rules.refuseIn(path)) {
            return;
        }
        const { tail } = emptyDirs.chainOf(path);
        await store.run(async () => {
            await store.createFile(joinPath(tail, `.gitkeep`));
            host.say(`Folder kept`);
        }, `Couldn't keep that folder.`);
    };

    // The sweep line names each branch, so one can be kept rather than all-or-nothing; the one pointed at is outlined in
    // the tree to match name to row.
    const sweepOpen = ref(false);
    const pointedBarren = ref<string | undefined>(undefined);
    const barrenBranches = computed<readonly BarrenBranch[]>(() => emptyDirs.roots.value.map((path) => branchOf(path, emptyDirs.chainOf)));
    // One branch needs no disclosure: the line just says it.
    const soleBarren = computed(() => (barrenBranches.value.length === 1 ? barrenBranches.value[0] : undefined));
    // Folds the disclosure closed once the list empties, so it can't spring open for an unrelated folder later.
    watch(barrenBranches, (branches) => {
        if (branches.length < 2) {
            sweepOpen.value = false;
        }
        if (!branches.some((branch) => branch.path === pointedBarren.value)) {
            pointedBarren.value = undefined;
        }
    });
    // The line's Clean up: every branch it names.
    const sweepAll = (): void => sweep(emptyDirs.roots.value);

    return {
        requestDelete,
        keepFolder,
        sweepOpen,
        pointedBarren,
        barrenBranches,
        soleBarren,
        sweepAll,
    };
};
