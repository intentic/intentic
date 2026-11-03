// needs jsdom: the rows, their links and presses as the reader meets them; the figures themselves are checkoutsView.test.ts's.
import "@intentic/testing/dom";
import type { CheckoutPress, CheckoutUsage } from "@intentic/sandbox-contract/schemas/metrics";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick } from "vue";
import { RouterLinkStub } from "../../../../testing/routerLinkStub";
import StorageCheckouts from "./StorageCheckouts.vue";

const row = (over: Partial<CheckoutUsage> & Pick<CheckoutUsage, "id">): CheckoutUsage => ({
    bytes: 1000,
    buildOutputBytes: 0,
    overlayBytes: 0,
    state: `idle`,
    updatedAt: Date.now(),
    can: { cleanBuildOutput: false, release: false, trash: false },
    ...over,
});

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const mount = (rows: readonly CheckoutUsage[], pressing?: string) => {
    const presses: { ids: string[]; press: CheckoutPress }[] = [];
    const el = document.createElement(`div`);
    document.body.append(el);
    // Icon, v-tooltip and RouterLink are registered app-wide (installUi, the router); stand-ins keep this off both.
    app = createApp({
        render: () =>
            h(StorageCheckouts, {
                rows,
                pressing,
                disabled: false,
                onPress: (pressed: readonly CheckoutUsage[], press: CheckoutPress) => presses.push({ ids: pressed.map((one) => one.id), press }),
            }),
    });
    app.component(`Icon`, IconStub);
    app.component(`RouterLink`, RouterLinkStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return { el, presses };
};

const pressesOf = (el: HTMLElement, id: string): string[] =>
    [...el.querySelectorAll(`[data-checkout="${id}"] [data-press]`)].map((button) => button.getAttribute(`data-press`) ?? ``);

test("each row links to its conversation and offers exactly the presses the daemon allows", () => {
    const { el } = mount([
        row({ id: `c1`, title: `Fix the login bug`, buildOutputBytes: 20_000, can: { cleanBuildOutput: true, release: true, trash: false } }),
        row({ id: `busy`, title: `Port the parser`, state: `working` }),
        row({ id: `stray`, state: `leftover`, updatedAt: undefined, can: { cleanBuildOutput: false, release: false, trash: true } }),
    ]);
    expect([...el.querySelectorAll(`[data-checkout]`)].map((li) => li.getAttribute(`data-checkout`))).toEqual([`c1`, `busy`, `stray`]);
    expect(el.querySelector(`[data-checkout="c1"] a`)?.getAttribute(`href`)).toBe(`/agents/c1`);
    // A leftover has no conversation to open.
    expect(el.querySelector(`[data-checkout="stray"] a`)).toBe(null);
    expect(pressesOf(el, `c1`)).toEqual([`cleanBuildOutput`, `release`]);
    expect(pressesOf(el, `busy`)).toEqual([]);
    expect(pressesOf(el, `stray`)).toEqual([`trash`]);
});

test("a press names its one row, and every landed checkout that may go is freed in one press", async () => {
    const landed = (id: string) => row({ id, state: `landed`, can: { cleanBuildOutput: true, release: true, trash: false }, buildOutputBytes: 5 });
    const { el, presses } = mount([landed(`l1`), landed(`l2`), row({ id: `held`, state: `held`, can: { cleanBuildOutput: false, release: true, trash: false } })]);
    el.querySelector<HTMLButtonElement>(`[data-checkout="l2"] [data-press="cleanBuildOutput"]`)?.click();
    await nextTick();
    const bulk = [...el.querySelectorAll<HTMLButtonElement>(`[data-storage-checkouts] > div button`)];
    expect(bulk.length).toBe(1);
    bulk[0]?.click();
    await nextTick();
    expect(presses).toEqual([
        { ids: [`l2`], press: `cleanBuildOutput` },
        { ids: [`l1`, `l2`], press: `release` },
    ]);
});

test("a long list folds behind one row until asked for whole", async () => {
    const { el } = mount(Array.from({ length: 12 }, (_, index) => row({ id: `c${String(index)}` })));
    expect(el.querySelectorAll(`[data-checkout]`).length).toBe(8);
    el.querySelector<HTMLButtonElement>(`button[aria-expanded="false"]`)?.click();
    await nextTick();
    expect(el.querySelectorAll(`[data-checkout]`).length).toBe(12);
});
