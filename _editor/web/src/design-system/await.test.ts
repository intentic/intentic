// A REGION'S WAIT, PINNED WHERE IT IS DECIDED. Every view draws "not here yet" through <Await> over a read's `Loaded`,
// so the bugs that came back view after view are pinned once, here:
// - a read held while the sandbox wakes is a wait, never an empty answer (the desktop's 30 s "request failed" page);
//   one the view has not asked for is never a wait (skeletons for ever);
// - nothing is drawn for a fast answer; past the delay, the remembered look, or the fallback before it was seen;
// - the look is taken only from the answer on screen, never from the placeholder or a region still hidden, and a region
//   that turned out empty is remembered as nothing (a section's header flashing in and out on /sandbox/public);
// - reads made inside the region as it first draws hold its remembered look until they answer, a region inside another
//   holds the outer one too, and no read holds it past the budget;
// - a long wait says how long it has run and offers to ask again; a failure says so, with a retry.
import "@intentic/testing/dom";
import { type Loaded, loadedFrom, type ReadFacts, useLoaded } from "@intentic/extension-api";
import { Await, MINIMUM_HOLD_MS, REVEAL_DELAY_MS } from "@intentic/ui";
import { emptyImprint, IMPRINT_VERSION, type SkeletonImprint } from "@intentic/ui/skeleton-imprint";
import { clearImprints, configureSkeletonSnapshots, imprintOf, rememberImprint } from "@intentic/ui/skeleton-store";
import { IconStub } from "@intentic/ui/testing";
import { type App, type Component, createApp, defineComponent, h, nextTick, ref, type Ref, shallowRef } from "vue";

const NAME = `test.region`;

const facts = (patch: Partial<ReadFacts<string>> = {}): ReadFacts<string> => ({
    data: undefined,
    error: undefined,
    fetching: false,
    wanted: true,
    ...patch,
});

describe(`loadedFrom`, () => {
    it(`says a read held while the sandbox does not answer is a wait, not an empty answer`, () => {
        expect(loadedFrom(facts({ fetching: false, wanted: true }), 7)).toEqual({ state: `waiting`, since: 7, retry: undefined });
    });

    it(`says a read the view has not asked for is idle, so nothing waits on it for ever`, () => {
        expect(loadedFrom(facts({ wanted: false }), 0)).toEqual({ state: `idle` });
    });

    it(`keeps the last answer through a refresh and its failure, and calls a retry after a failure a wait again`, () => {
        expect(loadedFrom(facts({ data: `rows`, fetching: true, error: `down` }), 0)).toEqual({
            state: `ready`,
            data: `rows`,
            refreshing: true,
            refreshError: `down`,
        });
        expect(loadedFrom(facts({ error: `down` }), 0)).toMatchObject({ state: `failed`, error: `down` });
        expect(loadedFrom(facts({ error: `down`, fetching: true }), 0)).toMatchObject({ state: `waiting` });
    });
});

// The two utilities <Await> lays its insides out with, as the app's stylesheet has them: jsdom loads no Tailwind.
beforeAll(() => {
    const sheet = document.createElement(`style`);
    sheet.textContent = `.contents { display: contents } .hidden { display: none }`;
    document.head.append(sheet);
});

const mounted: App[] = [];
afterEach(async () => {
    for (const app of mounted.splice(0)) {
        app.unmount();
    }
    document.body.innerHTML = ``;
    jest.useRealTimers();
    await clearImprints();
    configureSkeletonSnapshots({});
});

const mount = (render: () => ReturnType<typeof h>): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render });
    app.component(`Icon`, IconStub);
    app.mount(host);
    mounted.push(app);
    return host;
};

const flush = async (): Promise<void> => {
    for (let beat = 0; beat < 4; beat += 1) {
        await nextTick();
    }
};

const advance = async (ms: number): Promise<void> => {
    jest.advanceTimersByTime(ms);
    await flush();
};

const waiting = (): Loaded<string> => ({ state: `waiting`, since: Date.now(), retry: undefined });
const ready = (data: string): Loaded<string> => ({ state: `ready`, data, refreshing: false, refreshError: undefined });

// A remembered look of one bar, as a capture would have left it.
const remembered: SkeletonImprint = {
    v: IMPRINT_VERSION,
    at: 0,
    t: [`ghost-row`],
    root: { e: `div`, k: [{ e: `p`, c: 0, k: [{ h: 10, w: [80] }] }] },
};

const FALLBACK = { fallback: () => h(`p`, { "data-fallback": `` }) };
const answer = ({ data }: { readonly data: string }) => h(`p`, { "data-answer": `` }, data);

describe(`<Await>`, () => {
    beforeEach(() => jest.useFakeTimers());

    it(`draws nothing for a fast answer, then the fallback past the delay, and the answer once it holds long enough`, async () => {
        const read = shallowRef(waiting());
        const host = mount(() => h(Await, { of: read.value }, { default: answer, ...FALLBACK }));
        await advance(REVEAL_DELAY_MS - 1);
        expect(host.querySelector(`[data-fallback]`)).toBeNull();
        await advance(1);
        expect(host.querySelector(`[data-fallback]`)).not.toBeNull();

        read.value = ready(`rows`);
        await flush();
        expect(host.querySelector(`[data-fallback]`)).not.toBeNull();
        await advance(MINIMUM_HOLD_MS);
        expect(host.querySelector(`[data-fallback]`)).toBeNull();
        expect(host.querySelector(`[data-answer]`)?.textContent).toBe(`rows`);
    });

    it(`draws the region as it last looked once it has been seen, in place of the fallback`, async () => {
        rememberImprint(`default`, NAME, remembered);
        const host = mount(() => h(Await, { of: waiting(), imprint: NAME }, { default: answer, ...FALLBACK }));
        await advance(REVEAL_DELAY_MS);
        expect(host.querySelector(`[data-skeleton-snapshot]`)).not.toBeNull();
        expect(host.querySelector(`[data-fallback]`)).toBeNull();
    });

    it(`remembers a region that answered with nothing as nothing, so its next wait promises nothing`, async () => {
        rememberImprint(`default`, NAME, remembered);
        const empty = defineComponent({ render: () => null });
        mount(() => h(Await, { of: ready(``), imprint: NAME }, { default: () => h(empty) }));
        await flush();
        await advance(1_000);
        expect(imprintOf(NAME)?.root).toEqual(emptyImprint().root);
    });

    // A region whose insides read something of their own as they first draw: the reads join its wait.
    const Reading = (state: Ref<Loaded<string>>): Component =>
        defineComponent({
            setup() {
                const read = useLoaded<string>(() => {
                    const now = state.value;
                    return now.state === `ready` ? facts({ data: now.data }) : facts({ fetching: true });
                });
                return () => (read.value.state === `ready` ? null : h(`p`, { "data-half-read": `` }));
            },
        });

    it(`keeps its remembered look until the reads its insides make have answered, and takes nothing while they are out`, async () => {
        rememberImprint(`default`, NAME, remembered);
        const inner = ref<Loaded<string>>(waiting());
        const Inside = Reading(inner);
        const host = mount(() => h(Await, { of: ready(`code`), imprint: NAME }, { default: () => h(Inside) }));
        await advance(REVEAL_DELAY_MS);
        // The insides are mounted (their read is going) but not shown: the remembered look stands in their place.
        expect(host.querySelector(`[data-skeleton-snapshot]`)).not.toBeNull();
        expect(host.querySelector(`.hidden [data-half-read]`)).not.toBeNull();
        await advance(500);
        // A half-read region is never what the look is taken from.
        expect(imprintOf(NAME)).toBe(remembered);

        inner.value = ready(`rows`);
        await flush();
        await advance(MINIMUM_HOLD_MS);
        expect(host.querySelector(`[data-skeleton-snapshot]`)).toBeNull();
        expect(host.querySelector(`.hidden`)).toBeNull();
    });

    it(`stops holding past its budget, leaving a slow read to the insides that made it`, async () => {
        const inner = ref<Loaded<string>>(waiting());
        const Inside = Reading(inner);
        const host = mount(() => h(Await, { of: ready(`code`), imprint: NAME }, { default: () => h(Inside) }));
        await advance(2_500 + MINIMUM_HOLD_MS);
        expect(host.querySelector(`.hidden`)).toBeNull();
        expect(host.querySelector(`[data-half-read]`)).not.toBeNull();
    });

    it(`holds the region around it while a region inside still waits, so a page settles once`, async () => {
        const inner = shallowRef(waiting());
        const host = mount(() =>
            h(Await, { of: ready(`page`), imprint: `outer` }, { default: () => h(Await, { of: inner.value }, { default: answer, ...FALLBACK }) }),
        );
        await flush();
        expect(host.querySelector(`.hidden`)).not.toBeNull();

        inner.value = ready(`rows`);
        await flush();
        await advance(0);
        expect(host.querySelector(`.hidden`)).toBeNull();
        expect(host.querySelector(`[data-answer]`)?.textContent).toBe(`rows`);
    });

    it(`draws an answer already here at once, holding nothing`, async () => {
        const host = mount(() => h(Await, { of: ready(`rows`), imprint: NAME }, { default: answer }));
        await flush();
        expect(host.querySelector(`.hidden`)).toBeNull();
        expect(host.querySelector(`[data-answer]`)).not.toBeNull();
    });

    it(`says how long a long wait has run and offers to ask again`, async () => {
        const retry = jest.fn();
        const host = mount(() => h(Await, { of: { state: `waiting`, since: Date.now(), retry } }, FALLBACK));
        await advance(4_000);
        expect(host.textContent).not.toContain(`Still loading`);
        await advance(1_500);
        expect(host.textContent).toContain(`Still loading`);
        [...host.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Try again`))?.click();
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it(`says a read that gave up, with a way to try again`, async () => {
        const retry = jest.fn();
        const host = mount(() => h(Await, { of: { state: `failed`, error: `the daemon said no`, retry } }, { default: answer }));
        await flush();
        expect(host.textContent).toContain(`the daemon said no`);
        [...host.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Try again`))?.click();
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it(`draws nothing for a read the view has not asked for`, async () => {
        const host = mount(() => h(Await, { of: { state: `idle` } }, { default: answer, ...FALLBACK }));
        await advance(10_000);
        expect(host.textContent).toBe(``);
        expect(host.querySelector(`[data-fallback]`)).toBeNull();
    });

    // /settings/tokens drew "Couldn't load this" above its own notice saying the same: an empty `#failed` the view gave
    // fell through to the default. A slot the view gives is its word, even an empty one.
    it(`draws nothing for a failure the view said it words itself`, async () => {
        const host = mount(() => h(Await, { of: { state: `failed`, error: `Not Found`, retry: undefined } }, { default: answer, failed: () => [] }));
        await flush();
        expect(host.textContent).toBe(``);
    });
});
