import { computed, type Ref } from "vue";
import { launches, standingLaunches } from "../../../../models/fleet/launches/agentLaunches";
import { registry } from "../../../../models/fleet/useAgents-registry";

// The agents a press elsewhere is starting (agentLaunches.ts), at the head of the Active lane (LaunchCards.vue): the
// newest thing on the board and the one the reader was just sent here to see arrive. Each gives way to the agent's own
// card the moment the roster holds it. Not in the archive, which is another list wearing Finished's shape.
export const useBoardLaunches = (archive: Readonly<Ref<boolean>>) =>
    computed(() => (archive.value ? [] : standingLaunches(launches.value, (id) => registry.value.some((agent) => agent.id === id))));
