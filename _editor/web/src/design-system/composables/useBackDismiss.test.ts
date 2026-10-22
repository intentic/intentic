import "@intentic/testing/dom";
import { effectScope, nextTick, ref } from "vue";
import { createRouter, createWebHistory, type RouteComponent, type Router, type RouterHistory } from "vue-router";
import { overlayBackSettled, useBackDismiss } from "../../../../ui/src/composables/useBackDismiss";

// A sheet claims a history entry while open. These stand up the app's real arrangement (web history, the router's
// guard on overlayBackSettled) rather than faking the router with pushState, since the bug lived between the two.

const page: RouteComponent = { render: () => null };
// An in-shell view whose chunk arrives after the sheet's traversal would have landed.
const lateChunk = (): Promise<RouteComponent> => new Promise((resolve) => setTimeout(() => resolve(page), 50));

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// SAFETY: every entry in these tests is vue-router's or a sheet's, and both carry vue-router's numeric `position`.
const position = (): number => (history.state as { position: number }).position;

const withRouter = async (run: (router: Router, open: ReturnType<typeof ref<boolean>>) => Promise<void>): Promise<void> => {
    const original = `${location.pathname}${location.search}`;
    let routerHistory: RouterHistory | undefined;
    const scope = effectScope();
    try {
        routerHistory = createWebHistory();
        const router = createRouter({
            history: routerHistory,
            routes: [
                { path: `/agents`, component: page },
                { path: `/agents/picked`, component: page },
                { path: `/ext/workflows`, component: lateChunk },
            ],
        });
        router.beforeResolve(() => overlayBackSettled());
        await router.push(`/agents`);
        const open = ref(false);
        scope.run(() => useBackDismiss(open));
        await run(router, open);
    } finally {
        scope.stop();
        routerHistory?.destroy();
        history.replaceState(null, ``, original);
    }
};

describe(`a pick that closes a sheet and navigates`, () => {
    for (const [what, target] of [
        [`to a view already loaded`, `/agents/picked`],
        [`to a view whose chunk arrives late`, `/ext/workflows`],
    ] as const) {
        it(`is still on the picked route a second later, ${what}`, async () => {
            await withRouter(async (router, open) => {
                open.value = true;
                await nextTick();
                // The hosts' order: close the sheet, then navigate, in one handler (ChatSwitcherSheet, useRunThrough).
                open.value = false;
                const navigated = router.push(target);
                await navigated;
                await settle(1000);
                expect(router.currentRoute.value.path).toBe(target);
                expect(location.pathname).toBe(target);
            });
        });
    }
});

// A RouterLink inside a sheet runs its own navigate before the click handler that closes the sheet, so the push is
// already under way when the sheet steps back (the model picker's "Connect a model, or manage accounts", 2026-10-21).
it(`a link in the sheet, which navigates before the sheet closes, still lands on its route`, async () => {
    await withRouter(async (router, open) => {
        open.value = true;
        await nextTick();
        const navigated = router.push(`/agents/picked`);
        open.value = false;
        const failure = await navigated;
        await settle(1000);
        expect(failure).toBeUndefined();
        expect(router.currentRoute.value.path).toBe(`/agents/picked`);
        expect(location.pathname).toBe(`/agents/picked`);
    });
});

it(`gives the entry back when the sheet closes without navigating, so one back press still leaves the page`, async () => {
    await withRouter(async (_router, open) => {
        const below = position();
        open.value = true;
        await nextTick();
        expect(position()).toBe(below + 1);
        open.value = false;
        await nextTick();
        await settle(100);
        expect(position()).toBe(below);
        expect(location.pathname).toBe(`/agents`);
    });
});

it(`closing a sheet opened over another leaves the one underneath open`, async () => {
    await withRouter(async () => {
        const outer = ref(false);
        const inner = ref(false);
        const scope = effectScope();
        scope.run(() => {
            useBackDismiss(outer);
            useBackDismiss(inner);
        });
        try {
            outer.value = true;
            await nextTick();
            inner.value = true;
            await nextTick();
            inner.value = false;
            await nextTick();
            await settle(100);
            expect(outer.value).toBe(true);
            outer.value = false;
            await nextTick();
            await settle(100);
        } finally {
            scope.stop();
        }
    });
});
