import type { Persona } from "@intentic/sandbox-contract/schemas/personas";
import { computed, type Ref, ref, watch } from "vue";
import { projectScope, setProjectScope } from "../../../app/projectScope";
import { ownerFilter } from "../../agent-status/ownership";
import { useAgents } from "../useAgents";
import { attentionHidden } from "./scopeFleet";

// The rail badge counts the whole sandbox; the board shows the open project (and, if chosen, one person's work). So a
// badge of 2 over a board that says "Nothing needs you right now" was no bug in either number, only a count taken wider
// than the lane it points at, and clicking it on the board did nothing at all. This is what the narrowing hides, so
// the tile can say so, the Attention lane can offer it, and a press on the tile can widen it.

// What the shell hands over from where it can read them (the personas are a sandbox query, the address the session's).
const personasNow = ref<readonly Persona[]>([]);
const meNow = ref<string | undefined>(undefined);
// Called from a component's setup, so the copies follow the sources for as long as the shell is up.
export const trackScopeInputs = (personas: Readonly<Ref<readonly Persona[]>>, me: Readonly<Ref<string | undefined>>): void => {
    watch(personas, (next) => (personasNow.value = next), { immediate: true });
    watch(me, (next) => (meNow.value = next), { immediate: true });
};

const hiddenNow = (project: string | undefined, owner: string | undefined): number => {
    const agents = useAgents();
    return attentionHidden({
        fleet: agents.fleet.value,
        held: agents.heldWakes.value,
        personas: personasNow.value,
        project,
        owner,
        me: meNow.value,
    });
};

// How many of the badge's items sit outside the open project, for the tile's tooltip. Project only: that is the
// narrowing the tooltip names.
export const attentionOutsideProject = computed<number>(() => (projectScope.value === undefined ? 0 : hiddenNow(projectScope.value, undefined)));

// Bumped by a press on the Agents tile while the board is already on screen; the board answers it by scrolling to the
// Attention lane and marking its first card (AgentsView).
export const attentionAsk = ref(0);

// The press on the Agents tile while the board is already open (the router refuses a same-route visit, so it did
// nothing): widens whatever narrowing hides items that need the reader, then asks the board to show them. Each choice
// is cleared only when it is what hides something, so a project that holds everything stays open.
export const askForAttention = (): void => {
    // Nothing is owed, so there is nothing to widen the board for.
    if (useAgents().attention.value <= 0) {
        return;
    }
    if (projectScope.value !== undefined && attentionOutsideProject.value > 0) {
        setProjectScope(undefined);
    }
    if (ownerFilter.value !== undefined && hiddenNow(projectScope.value, ownerFilter.value) > 0) {
        ownerFilter.value = undefined;
    }
    attentionAsk.value += 1;
};
