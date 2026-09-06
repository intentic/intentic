import { computed, inject, provide, type ComputedRef, type InjectionKey } from "vue";

/* THE WAY OUT OF A FULL-SCREEN VIEW, published by the shell and worn by <PageHeader>.
 *
 * A phone shows one view at a time, so every screen the reader drills INTO has to say how to get back out.
 * The desktop never needs it: the rail that opened the view is still on screen beside it, and the view is one
 * pane of a window rather than the whole of it. The mobile shell has a bottom tab bar and nothing else, so a
 * route that is not one of the four tabs — a hub, a capability card, an extension's area — used to be reachable
 * only forwards: the tab bar's Menu returns to the MENU, not to wherever the reader actually came from, and a
 * deep link (a notification tap, a chat card, a shared URL) had no in-view exit at all.
 *
 * PROVIDED, NOT A PROP, for <SplitView>'s reason verbatim (splitView.ts): the shell is the only thing that
 * knows which routes are tab roots and whether there is history behind this one, and the header is drawn 20
 * components down by pages the shell never names — three hubs and every extension that renders a PageHeader.
 * Passing a prop would mean editing each of them and would leave the next one to be written with no back arrow
 * and no way to know it needed one. An injection reaches all of them at once, and reaches NOTHING on the
 * desktop, where the shell provides nothing and the default below is the honest answer.
 *
 * The kit cannot import the router (extensions consume it, and it is mounted in surfaces that have none), so
 * what crosses this boundary is an already-resolved intent: a label and a function. Where it goes is the
 * shell's business. */

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
