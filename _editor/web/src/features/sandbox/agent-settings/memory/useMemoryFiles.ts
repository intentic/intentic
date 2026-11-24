import { computed, type ComputedRef } from "vue";
import { useWorkspaceTree } from "../../../../models/workspace/tree/useWorkspaceTree";
import { type MemoryFile, memoryFilesIn } from "./memoryFiles";

// The memory files as the Workspace's tree holds them right now: one walk per tree the watcher pushes, never a read.

export interface MemoryFiles {
    /** The workspace's own, which every turn reads; undefined while it has not been written. */
    readonly root: ComputedRef<MemoryFile | undefined>;
    /** Each folder's own, read by the turns that start inside it. */
    readonly folders: ComputedRef<readonly MemoryFile[]>;
    readonly byPath: ComputedRef<ReadonlyMap<string, MemoryFile>>;
    /** The tree has answered at least once: before that, a missing root file is not known to be missing. */
    readonly loaded: ComputedRef<boolean>;
}

export function useMemoryFiles(): MemoryFiles {
    const { tree, hasSnapshot } = useWorkspaceTree();
    const files = computed(() => memoryFilesIn(tree.value));
    return {
        root: computed(() => files.value.find((file) => file.folder === ``)),
        folders: computed(() => files.value.filter((file) => file.folder !== ``)),
        byPath: computed(() => new Map(files.value.map((file) => [file.path, file]))),
        loaded: hasSnapshot,
    };
}
