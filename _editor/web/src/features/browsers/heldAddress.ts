import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from "vue";

// Where Enter sent a page, said in the address bar until the page reports getting there, the way a browser keeps the
// typed address up while the page loads. Without it the bar fell back at once to the address being left, or to nothing
// on a tab still opening, as though what was typed had been thrown away (2026-10-08).
//
// A hold is for one tab, by page id: shown while that tab is the active one, and let go once it reports any address but
// the one it was sent from (a blank page's is never an arrival), or after HELD_MS without word, which a navigation that
// never commits would otherwise hold forever. A hold whose tab is not known yet (the person's own window still
// starting) stands for whichever tab is active until `settle` names it; the caller settles or releases it as the open
// answers.

const HELD_MS = 15_000;
const BLANK = `about:blank`;

const arrived = (address: string): boolean => address !== `` && address !== BLANK;

export interface HeldAddress {
    // The held address while its tab is the active one; undefined otherwise.
    readonly shown: ComputedRef<string | undefined>;
    // `page` undefined: a tab still opening, named later by `settle`.
    readonly hold: (url: string, page: string | undefined) => void;
    readonly settle: (page: string) => void;
    readonly release: () => void;
}

export const useHeldAddress = (activePage: Ref<{ readonly id: string; readonly url: string } | undefined>): HeldAddress => {
    const held = ref<{ readonly url: string; readonly page: string | undefined; readonly from: string } | undefined>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const release = (): void => {
        held.value = undefined;
        clearTimeout(timer);
    };

    const hold = (url: string, page: string | undefined): void => {
        // A tab still opening has no address to leave; one already open leaves the one it reports now.
        const from = page === undefined || activePage.value?.id !== page ? BLANK : activePage.value.url;
        held.value = { url, page, from };
        clearTimeout(timer);
        timer = setTimeout(release, HELD_MS);
    };

    const settle = (page: string): void => {
        if (held.value !== undefined && held.value.page === undefined) {
            held.value = { ...held.value, page };
        }
    };

    // Read whenever the active tab or its address moves: coming back to the held tab after it arrived lets go too.
    watch(
        () => [activePage.value?.id, activePage.value?.url] as const,
        ([id, url]) => {
            const current = held.value;
            if (current !== undefined && current.page !== undefined && current.page === id && url !== undefined && arrived(url) && url !== current.from) {
                release();
            }
        },
    );

    onScopeDispose(() => clearTimeout(timer));

    const shown = computed(() => {
        const current = held.value;
        return current !== undefined && (current.page === undefined || current.page === activePage.value?.id) ? current.url : undefined;
    });

    return { shown, hold, settle, release };
};
