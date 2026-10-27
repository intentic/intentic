import { computed, type ComputedRef, inject, provide, type Ref, ref } from "vue";

// Which chat's allowance the capacity rail already says, so the pane's own chip can step aside rather than print the
// same figure twice on one screen. Scoped to one ChatPanel by provide/inject: a docked chat, a quick bar or another
// window never hides its chip for a rail it can't see.
//
// The rail writes the row it draws marked (`provider:account`, PlanLimitRow's id) into `marked`; the panel reads it
// out as `carried` only while the rail stands beside a single chat. In a split the rail marks the focused chat alone,
// and a chip that came and went as focus moved between columns would read as the panes changing under the reader.
interface RailCarries {
    readonly marked: Ref<string | undefined>;
    readonly carried: ComputedRef<string | undefined>;
}

const KEY = Symbol(`railCarries`);

/** ChatPanel's half: what the rail may write, and when its mark counts. */
export const provideRailCarries = (beside: () => boolean): void => {
    const marked = ref<string>();
    provide<RailCarries>(KEY, { marked, carried: computed(() => (beside() ? marked.value : undefined)) });
};

/** The rail's half: the row it is drawing for the chat beside it; undefined when it draws none, or unmounts. */
export const useRailMark = (): Ref<string | undefined> | undefined => inject<RailCarries | undefined>(KEY, undefined)?.marked;

/** The pane's half: whether the rail beside it is already saying this account's allowance. */
export const useRailCarries = (): ComputedRef<string | undefined> => {
    const carries = inject<RailCarries | undefined>(KEY, undefined);
    return computed(() => carries?.carried.value);
};
