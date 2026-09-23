// Pins the page's URL as its state: every move's next address and whether it is a history stop, what survives leaving
// a tile, and what the page reads off the URL (the open tile, the connection being edited, the slice, the walk),
// including the bounce off a tile slug nothing answers to.
import type { CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATALOG, type CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { type EffectScope, effectScope, nextTick, reactive, ref } from "vue";
import { type PageMove, type PageRoute, type PageStep, pageStep, SETUP, useCapabilityRoute } from "./capabilityRoute";

const NAME = `capabilities`;
// Mid-edit on the GitHub tile, filtered, inside the walk: every part of the query a move may carry or drop.
const FROM: PageRoute = { params: { entry: `github` }, query: { category: `code`, q: `git`, edit: `github-ada`, setup: SETUP } };
const KEPT = { category: `code`, q: `git`, edit: undefined, setup: SETUP };

describe(`a move from the URL as it stands`, () => {
    const cases: [PageMove, PageStep][] = [
        [
            { kind: `tile`, entry: `gitlab` },
            { how: `push`, to: { name: NAME, params: { entry: `gitlab` }, query: KEPT } },
        ],
        [{ kind: `back` }, { how: `push`, to: { name: NAME, query: KEPT } }],
        [
            { kind: `edit`, id: `github` },
            { how: `replace`, to: { name: NAME, params: FROM.params, query: { ...FROM.query, edit: `github` } } },
        ],
        [
            { kind: `edit`, id: `` },
            { how: `replace`, to: { name: NAME, params: FROM.params, query: { ...FROM.query, edit: undefined } } },
        ],
        [
            { kind: `connection`, entry: `vpn`, connection: `office` },
            { how: `push`, to: { name: NAME, params: { entry: `vpn` }, query: { ...KEPT, edit: `office` } } },
        ],
        [
            { kind: `connection`, entry: `linux`, connection: `device:radarsu-rog` },
            { how: `push`, to: { name: NAME, params: { entry: `linux` }, query: { ...KEPT, device: `radarsu-rog` } } },
        ],
        [
            { kind: `filter`, key: `category`, value: `data` },
            { how: `replace`, to: { name: NAME, query: { ...KEPT, category: `data` } } },
        ],
        [
            { kind: `filter`, key: `q`, value: `` },
            { how: `replace`, to: { name: NAME, query: { ...KEPT, q: undefined } } },
        ],
        [
            { kind: `walk`, entry: `gitlab` },
            { how: `push`, to: { name: NAME, params: { entry: `gitlab` }, query: KEPT } },
        ],
        [{ kind: `finish` }, { how: `push`, to: { name: NAME, query: { ...KEPT, setup: undefined } } }],
        [{ kind: `unknown` }, { how: `replace`, to: { name: NAME, query: KEPT } }],
    ];
    for (const [move, step] of cases) {
        it(`${move.kind} ${JSON.stringify(move)}`, () => {
            expect(pageStep(FROM, move)).toStrictEqual(step);
        });
    }

    it(`starts the walk with its mark, from a URL that had none`, () => {
        expect(pageStep({ params: {}, query: { q: `git` } }, { kind: `walk`, entry: `gitlab` })).toStrictEqual({
            how: `push`,
            to: { name: NAME, params: { entry: `gitlab` }, query: { q: `git`, edit: undefined, setup: SETUP } },
        });
    });
});

const catalogEntry = (id: string): CapabilityCatalogEntry => CAPABILITY_CATALOG.find((entry) => entry.id === id)!;
const instance = (id: string, kind: CapabilitySummary[`kind`], config: Record<string, string> = {}): CapabilitySummary => ({
    id,
    kind,
    status: { state: `active` },
    config,
    secrets: [],
});

const scopes: EffectScope[] = [];
afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

// The page over a live, reactive URL; `settled` is whether /extensions has answered.
const pageAt = (entry: string, query: Record<string, string> = {}, settled = true) => {
    const route = reactive<PageRoute>({ params: { entry }, query });
    const router = { push: mock(), replace: mock() };
    const state = {
        entries: ref([catalogEntry(`vpn`), catalogEntry(`docker`)]),
        capabilities: ref([
            instance(`office`, `vpn`, { provider: `wireguard` }),
            instance(`home`, `vpn`, { provider: `fortinet` }),
            instance(`docker`, `docker`),
        ]),
        settled: ref(settled),
    };
    const scope = effectScope();
    scopes.push(scope);
    const page = scope.run(() => useCapabilityRoute({ route, router, ...state }))!;
    return { route, router, state, page };
};

describe(`what the page reads off its URL`, () => {
    it(`opens the tile the path names, over the connection the query names`, () => {
        const { page } = pageAt(`vpn`, { edit: `home` });

        expect(page.selected.value?.id).toBe(`vpn`);
        expect(page.selectedInstances.value.map((found) => found.id)).toEqual([`office`, `home`]);
        expect(page.soleInstance.value).toBeUndefined();
        expect(page.editing.value?.id).toBe(`home`);
    });

    it(`adds rather than editing nothing when the edited connection is gone`, () => {
        expect(pageAt(`vpn`, { edit: `gone` }).page.editing.value).toBeUndefined();
    });

    it(`edits a singleton tile's one connection with no query at all`, () => {
        const { page } = pageAt(`docker`);

        expect(page.soleInstance.value?.id).toBe(`docker`);
        expect(page.editing.value?.id).toBe(`docker`);
    });

    it(`reads the slice, the filter, an arriving machine and the walk, and writes the filter back by replacing`, () => {
        const { page, router } = pageAt(``, { category: `servers`, q: `vpn`, device: `radarsu-rog`, setup: SETUP });

        expect([page.scope.value, page.search.value, page.device.value, page.walking.value]).toEqual([`servers`, `vpn`, `radarsu-rog`, true]);
        page.search.value = `ssh`;
        expect(router.replace.mock.calls).toEqual([
            [{ name: NAME, query: { category: `servers`, q: `ssh`, device: `radarsu-rog`, setup: SETUP, edit: undefined } }],
        ]);
        expect(pageAt(``, { q: [`a`, `b`] as never }).page.search.value).toBe(``);
    });

    it(`takes each gesture to its step`, () => {
        const { page, router } = pageAt(`vpn`, { edit: `office` });

        page.pick(catalogEntry(`docker`));
        page.back();
        page.openConnection(`vpn`, `home`);
        expect(router.push.mock.calls).toEqual([
            [{ name: NAME, params: { entry: `docker` }, query: { edit: undefined } }],
            [{ name: NAME, query: { edit: undefined } }],
            [{ name: NAME, params: { entry: `vpn` }, query: { edit: `home` } }],
        ]);
        page.openEdit(`home`);
        page.stopEditing();
        expect(router.replace.mock.calls).toEqual([
            [{ name: NAME, params: { entry: `vpn` }, query: { edit: `home` } }],
            [{ name: NAME, params: { entry: `vpn` }, query: { edit: undefined } }],
        ]);
    });
});

describe(`a tile slug nothing answers to`, () => {
    it(`bounces to the grid once extensions have answered`, () => {
        const { router } = pageAt(`no-such-tile`, { q: `x` });

        expect(router.replace.mock.calls).toEqual([[{ name: NAME, query: { q: `x`, edit: undefined } }]]);
    });

    it(`waits for extensions first, since a deep-linked connector tile is unknown until they arrive`, async () => {
        const { router, state } = pageAt(`reddit`, {}, false);
        expect(router.replace.mock.calls).toEqual([]);

        state.settled.value = true;
        await nextTick();
        expect(router.replace.mock.calls).toEqual([[{ name: NAME, query: { edit: undefined } }]]);
    });

    it(`leaves a known tile and the bare catalog alone`, () => {
        expect(pageAt(`vpn`).router.replace.mock.calls).toEqual([]);
        expect(pageAt(``).router.replace.mock.calls).toEqual([]);
    });
});
