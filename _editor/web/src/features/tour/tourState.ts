import { computed, type Ref, shallowRef } from "vue";
import type { Progress } from "./steps";
import type { MarkStep } from "./tourMarks";

// WHAT THE TOUR'S MARKS READ, and nothing they would have to import a feature for. The getting-started checklist
// (features/gettingStarted) works out where a first run stands from the agents, the chat and the workspace, and
// publishes it here; the marks drawn inside those same features read it from here. The arrow points one way: a feature
// that hosts a mark imports this layer, never the checklist that imports it.

// The one press a hint may offer that is not a route: done by whoever published, which knows how.
export type TourAction = `writeTask` | `skipWork`;

export interface TourSource {
    readonly moment: Readonly<Ref<MarkStep | undefined>>;
    readonly progress: Readonly<Ref<Progress>>;
    readonly visible: Readonly<Ref<boolean>>;
    // A first agent would run on the free trial, which is worth saying: nothing needs connecting first.
    readonly trial: Readonly<Ref<boolean>>;
    readonly run: (action: TourAction) => void;
}

// What it holds is scoped per sandbox where it is computed (useGettingStarted), so a switch moves every answer with it.
// allow(module-state): the window's one checklist, published once by the shell
const source = shallowRef<TourSource | undefined>(undefined);

export const publishTour = (published: TourSource): void => {
    source.value = published;
};

export const tourMoment = computed(() => source.value?.moment.value);
export const tourProgress = computed(() => source.value?.progress.value);
export const tourVisible = computed(() => source.value?.visible.value === true);
export const tourTrial = computed(() => source.value?.trial.value === true);

export const runTourAction = (action: TourAction): void => source.value?.run(action);
