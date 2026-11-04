import { HOME_SEGMENT, homePath, insidePath, page, SANDBOX_PAGES, SANDBOX_SEGMENT } from "@intentic/sandbox-contract/app-routes";
import { createMemoryHistory, createRouter, type RouteRecordRaw } from "vue-router";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { readRoutesOf, routeName } from "../../lib/routes/links";
import { addressOf, linksApi } from "../apiLinks";

/* An extension's links: a page from `api.links` opens in the reader's frame and sandbox, and a path from an extension built
   against an older API is read as the address from before frames it was. A real router in the shell's shape. */

const view = { render: () => null };
const router = createRouter({
    history: createMemoryHistory(),
    routes: [
        { path: `/login`, component: view },
        ...([`agents`, `capabilities`, `extension`, `sandboxSettings`] as const).flatMap((name): RouteRecordRaw[] => [
            { path: `/${SANDBOX_SEGMENT}/:sandbox/${SANDBOX_PAGES[name]}`, name: routeName(`inside`, name), meta: { frame: `inside`, page: name }, component: view },
            { path: `/${HOME_SEGMENT}/:sandbox/${SANDBOX_PAGES[name]}`, name: routeName(`home`, name), meta: { frame: `home`, page: name }, component: view },
        ]),
    ],
});
readRoutesOf(router);

const BOX = `a1b2c3d4e5f6`;
const OTHER = `0f0f0f0f0f0f`;

beforeEach(() => {
    activeSandboxId.value = BOX;
});

describe(`a link an extension makes`, () => {
    it(`is the editor's own constructors`, () => {
        expect(linksApi.links).toBe(page);
    });

    it(`opens in the frame and the sandbox the reader is in`, async () => {
        await router.push(insidePath(BOX, page.agents()));
        expect(addressOf(page.capabilities())).toBe(insidePath(BOX, page.capabilities()));
        await router.push(homePath(BOX, page.agents()));
        expect(addressOf(page.extension(`pipelines`, undefined, { query: { repo: `web` } }))).toBe(
            homePath(BOX, page.extension(`pipelines`, undefined, { query: { repo: `web` } })),
        );
    });
});

describe(`a path an older extension sends`, () => {
    it(`is the page it meant before frames, where a link to it would open`, async () => {
        await router.push(homePath(BOX, page.agents()));
        expect(addressOf(`/capabilities`)).toBe(homePath(BOX, page.capabilities()));
        expect(addressOf(`/sandbox/extensions?view=installed`)).toBe(homePath(BOX, page.sandboxSettings(`extensions`, { query: { view: `installed` } })));
        await router.push(insidePath(BOX, page.agents()));
        expect(addressOf(`/ext/pipelines?repo=web#run`)).toBe(insidePath(BOX, page.extension(`pipelines`, undefined, { query: { repo: `web` }, hash: `run` })));
    });

    it(`opens on the sandbox it names`, async () => {
        await router.push(insidePath(BOX, page.agents()));
        expect(addressOf(`/agents?sandbox=${OTHER}`)).toBe(insidePath(OTHER, page.agents()));
    });

    it(`goes as it is when it names no page of a sandbox`, () => {
        expect(addressOf(`/login`)).toBe(`/login`);
        expect(addressOf(insidePath(OTHER, page.agents()))).toBe(insidePath(OTHER, page.agents()));
    });
});
