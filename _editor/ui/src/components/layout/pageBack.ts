import { computed, inject, provide, type ComputedRef, type InjectionKey } from "vue";

// Published by the shell, worn by <PageHeader>: the way out of a full-screen view on a phone (desktop keeps its rail on
// screen). Provided, not a prop, since only the shell knows whether there's history behind a route, and a header can
// sit far below it. Crosses as a resolved label + function, since the kit cannot import the router.

export interface PageBack {
    /** The control's accessible name — the shell names the destination where it knows it ("Back to Menu"). */
    readonly label: string;
    readonly go: () => void;
}

const PAGE_BACK: InjectionKey<ComputedRef<PageBack | undefined>> = Symbol(`ui.page.back`);

export const providePageBack = (back: ComputedRef<PageBack | undefined>): void => provide(PAGE_BACK, back);

/** Undefined everywhere the shell has not published one: every desktop surface, and every mobile tab root. */
export function usePageBack(): ComputedRef<PageBack | undefined> {
    return inject(
        PAGE_BACK,
        computed(() => undefined),
    );
}
