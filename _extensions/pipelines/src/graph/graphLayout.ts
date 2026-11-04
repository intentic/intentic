import { useRailMemory } from "@intentic/extension-ui";
import { computed, ref, type WritableComputedRef } from "vue";

// Which way every job graph on this browser runs: stages as columns, left to right (the forge's own drawing), or as rows,
// top to bottom, each job one line, read down the page. One choice for the board, the full-screen graph and the side
// panel, so switching one graph switches them all, and remembered, so the board opens the way it was left.
export type GraphLayout = `columns` | `rows`;

const LAYOUTS: readonly GraphLayout[] = [`columns`, `rows`];

// Unset until a graph mounts and the kit's memory puts the last pick back: this browser's, kept across sign-out.
const chosen = ref<GraphLayout | undefined>();

// The layout every graph reads and the switch writes; columns until a reader has picked.
export const useGraphLayout = (): WritableComputedRef<GraphLayout> => {
    const remembered = useRailMemory(`pipelines.graphLayout`, chosen, () => LAYOUTS);
    return computed<GraphLayout>({
        get: () => remembered.value ?? `columns`,
        set: (next) => {
            remembered.value = next;
        },
    });
};
