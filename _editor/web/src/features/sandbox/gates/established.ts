import { computed, type ComputedRef } from "vue";
import { registry } from "../../agents/fleet/useAgents-registry";
import { useWorkspaceTree } from "../../workspace/explorer/useWorkspaceTree";

// Whether the active sandbox has something to paint before it answers: a workspace tree from the last visit, or a roster
// restored from it (useAgents-registry.ts), which is what a phone's board draws. The gate (SandboxGate.vue) and the
// notification lane read this one answer, so an outage is explained by exactly one of them: while they disagreed, a
// board painted from a restored roster was neither gated nor carded, and a sandbox that stopped answering said nothing.
export const useSandboxEstablished = (): ComputedRef<boolean> => {
    const { hasSnapshot } = useWorkspaceTree();
    return computed(() => hasSnapshot.value || registry.value.length > 0);
};
