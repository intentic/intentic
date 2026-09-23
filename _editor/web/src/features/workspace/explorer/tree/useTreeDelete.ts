import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { computed, nextTick, type Ref, ref, watch } from "vue";
import type { useNotifications } from "../../../../shell/notifications/notifications";
import type { BarrenChain } from "../emptyDirs";
import { deletedReceipt, deleteHeader, joinPath } from "../entryNames";
import { ancestorDirs } from "../revealPath";
import type { useEmptyDirs } from "../useEmptyDirs";
import type { useWorkspaceTree } from "../useWorkspaceTree";
import type { useTreeRules } from "./useTreeRules";
import type { useTreeSelection } from "./useTreeSelection";

// Deleting from the tree: a confirm that names what goes, and a receipt once it has; and the empty-folder sweep line,
// which deletes without asking, since nothing is lost and Undo rebuilds exactly what went.

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

// What sweeping these branches says, and what its Undo recreates: each chain's deepest folder, which brings back every
// folder above it. Planned before the delete, since the tree won't know the shape after.
export const sweepPlan = (
    roots: readonly string[],
    emptyDirs: Pick<ReturnType<typeof useEmptyDirs>, "chainOf" | "branchDirs">,
): { readonly leaves: readonly string[]; readonly receipt: string } => {
    const dirs = roots.flatMap((root) => emptyDirs.branchDirs(root));
    const leaves = dirs.filter((dir) => !dirs.some((other) => other !== dir && other.startsWith(`${dir}/`)));
    const [only] = roots;
    if (roots.length !== 1 || only === undefined) {
        return { leaves, receipt: `${roots.length} empty folders removed` };
    }
    // The whole path in one string: a receipt has no room to shade the two parts differently.
    const branch = branchOf(only, emptyDirs.chainOf);
    return { leaves, receipt: `${branch.where === `` ? branch.label : `${branch.where} / ${branch.label}`} removed` };
};

export interface TreeDeleteHost {
    readonly byPath: Readonly<Ref<ReadonlyMap<string, WorkspaceTreeEntry>>>;
    readonly targetDir: (path: string | null) => string;
    readonly rules: Pick<ReturnType<typeof useTreeRules>, "refuseIn" | "unlockedOnly">;
    readonly emptyDirs: ReturnType<typeof useEmptyDirs>;
    readonly selecting: Pick<ReturnType<typeof useTreeSelection>, "selection" | "lead" | "selectSingle" | "clear">;
    readonly store: Pick<ReturnType<typeof useWorkspaceTree>, "run" | "removeEntries" | "createDir" | "createFile" | "refuseWrite">;
    readonly say: ReturnType<typeof useNotifications>["say"];
    readonly openAll: (dirs: readonly string[]) => void;
    readonly showRow: (path: string) => Promise<HTMLElement | undefined>;
}

export const useTreeDelete = (host: TreeDeleteHost) => {
    const { store, emptyDirs, selecting } = host;
    // Paths pending delete confirmation: also drives the confirm dialog's visibility.
    const confirmPaths = ref<readonly string[] | undefined>(undefined);
    const deleteTitle = computed<string>(() =>
        confirmPaths.value === undefined ? `` : deleteHeader(confirmPaths.value, (path) => host.byPath.value.get(path)?.type),
    );

    const sweep = (roots: readonly string[]): void => {
        if (roots.length === 0 || store.refuseWrite()) {
            return;
        }
        const { leaves, receipt } = sweepPlan(roots, emptyDirs);
        void store.run(async () => {
            await store.removeEntries(roots);
            host.say(receipt, async () => {
                for (const dir of leaves) {
                    await store.createDir(dir);
                }
            });
        }, `Couldn't delete that.`);
        selecting.clear();
    };
    // Barren-only selections skip the confirm dialog: nothing is lost, and Undo recreates the folder exactly.
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
        confirmPaths.value = paths;
    };
    // The receipt is named while the tree still knows what went, and said only once the delete lands. No Undo, unlike the
    // sweep's: there is no trash to restore from, and a button that only sometimes brings a file back is worse than none.
    const confirmDelete = (): void => {
        const paths = confirmPaths.value;
        confirmPaths.value = undefined;
        if (paths === undefined) {
            return;
        }
        const named = deletedReceipt(paths);
        void store.run(async () => {
            await store.removeEntries(paths);
            host.say(named);
        }, `Couldn't delete that.`);
        selecting.clear();
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
    // Opens the path down to the folder, scrolls it into view and selects it, as revealing the open file does. Selection
    // rather than focus, so the keyboard stays with the list the user is working through.
    const revealBarren = async (path: string): Promise<void> => {
        host.openAll(ancestorDirs(path));
        selecting.selectSingle(path);
        await nextTick();
        await host.showRow(path);
    };
    // Reads `soleBarren` here, not in the template, since a template closure would read it outside the `v-if` proving it.
    const revealSoleBarren = async (): Promise<void> => {
        const sole = soleBarren.value;
        if (sole !== undefined) {
            await revealBarren(sole.path);
        }
    };

    return {
        confirmPaths,
        deleteTitle,
        requestDelete,
        confirmDelete,
        keepFolder,
        sweepOpen,
        pointedBarren,
        barrenBranches,
        soleBarren,
        sweepAll,
        revealBarren,
        revealSoleBarren,
    };
};
