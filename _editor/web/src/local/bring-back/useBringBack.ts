import { onMounted, onUnmounted, shallowRef } from "vue";
import { askLocalApp, LOCAL_PROJECT_EVENT, type SyncDirection } from "../../app/environments/local";
import { answered, BRING_BACK_CAP, type BringBackState, chosenPaths, IDLE, projectAnswer, type SandboxChange } from "./bringBack";

// The Bring back section's state and its four asks (bringBack.ts). Each ask moves the section to its waiting step and
// sends one link; the app's `intentic:project` answer, whenever it lands, settles it.
export const useBringBack = () => {
    const state = shallowRef<BringBackState>(IDLE);
    const onAnswer = (event: Event): void => {
        const answer = projectAnswer(event);
        if (answer !== undefined) {
            state.value = answered(state.value, answer);
        }
    };
    onMounted(() => window.addEventListener(LOCAL_PROJECT_EVENT, onAnswer));
    onUnmounted(() => window.removeEventListener(LOCAL_PROJECT_EVENT, onAnswer));

    const check = (): void => {
        state.value = { ...state.value, step: { at: `checking` } };
        askLocalApp(`changes`);
    };
    // The chosen changes, always by name, so what comes back is what the review showed. Nothing chosen, or more than one
    // link carries, is refused here as the review refuses it.
    const bringBack = (changes: readonly SandboxChange[], chosen: ReadonlySet<string>): void => {
        const paths = chosenPaths(changes, chosen);
        if (paths.length === 0 || paths.length > BRING_BACK_CAP) {
            return;
        }
        state.value = { ...state.value, step: { at: `bringing`, count: paths.length } };
        askLocalApp(`bring-back`, { paths });
    };
    // Puts the folder back where the last bring-back found it.
    const undo = (): void => {
        const { step } = state.value;
        if (step.at !== `brought`) {
            return;
        }
        state.value = { ...state.value, step: { at: `restoring` } };
        askLocalApp(`restore`, { point: step.point });
    };
    const switchTo = (direction: SyncDirection): void => {
        state.value = { ...state.value, switching: true, switchError: undefined };
        askLocalApp(`direction`, { value: direction });
    };

    return { state, check, bringBack, undo, switchTo };
};
