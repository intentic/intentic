import { computed, inject, provide, type ComputedRef, type InjectionKey } from "vue";
import { useDevice } from "../composables/useDevice.js";

/* IS THE SPLIT FOLDED — <SplitView>'s own answer, published to whatever it renders in its rail.
 *
 * The rail and the shell have to agree, and only one of them can measure. A rail that swaps itself to a compact
 * control (a Picker instead of a column of rows) used to ask `useDevice().mobile`, which is a fact about the
 * SCREEN, so in a 500px workspace pane on a 1920px monitor the shell folded the rail above the body while the
 * rail itself still drew the 16rem column it draws on a desktop. One question, two sources, two answers.
 *
 * Outside a <SplitView> there is nothing measuring, so the phone is the only narrow case left and the device
 * flag is the honest fallback, a picker in a bottom sheet is still the right control at that width. */
const COMPACT: InjectionKey<ComputedRef<boolean>> = Symbol(`ui.split.compact`);

export const provideCompact = (compact: ComputedRef<boolean>): void => provide(COMPACT, compact);

export function useCompact(): ComputedRef<boolean> {
    const provided = inject(COMPACT, undefined);
    if (provided !== undefined) {
        return provided;
    }
    const { mobile } = useDevice();
    return computed(() => mobile.value);
}
