import { computed, inject, provide, type ComputedRef, type InjectionKey } from "vue";
import { useDevice } from "../../composables/useDevice.js";

/* IS THE SPLIT FOLDED: <SplitView>'s own answer, published to whatever it renders in its rail. */
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
