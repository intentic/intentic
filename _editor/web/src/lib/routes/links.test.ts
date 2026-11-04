import { HOME_SEGMENT, homePath, insidePath, localPath, page, SANDBOX_PAGES, SANDBOX_SEGMENT } from "@intentic/sandbox-contract/app-routes";
import { computed } from "vue";
import { createMemoryHistory, createRouter, type RouteRecordRaw } from "vue-router";
import { wearFace } from "../../app/environments/local";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import {
    currentRoute,
    frameOf,
    here,
    hereIn,
    isPage,
    linkOf,
    pageCovers,
    pageOf,
    readRoutesOf,
    routeName,
    routeSandbox,
    routeShows,
    samePage,
    toFloating,
    toHome,
    toInside,
    toTop,
} from "./links";

/* The editor's links: made in the frame and sandbox of the route on screen, and the route read back the same way. A real
   router in the shell's shape, so `here` follows it as a template would. */

const view = { render: () => null };
const router = createRouter({
    history: createMemoryHistory(),
    routes: [
        { path: `/login`, component: view },
        { path: `/home/account/:tab?`, name: routeName(`home`, `account`), meta: { frame: `home`, page: `account` }, component: view },
        { path: `/home/:sandbox?`, name: `home`, meta: { frame: `home` }, component: view },
        { path: `/s/:sandbox/account/:tab?`, name: routeName(`inside`, `account`), meta: { frame: `inside`, page: `account` }, component: view },
        ...([`agents`, `agent`, `workspace`] as const).flatMap((name): RouteRecordRaw[] => [
            {
                path: `/${SANDBOX_SEGMENT}/:sandbox/${SANDBOX_PAGES[name]}`,
                name: routeName(`inside`, name),
                meta: { frame: `inside`, page: name },
                component: view,
            },
            {
                path: `/${HOME_SEGMENT}/:sandbox/${SANDBOX_PAGES[name]}`,
                name: routeName(`home`, name),
                meta: { frame: `home`, page: name },
                component: view,
            },
        ]),
    ],
});

const BOX = `a1b2c3d4e5f6`;

beforeEach(() => {
    activeSandboxId.value = `opened-last`;
});

describe(`before the router is installed`, () => {
    it(`reads no route, and makes a link inside the sandbox opened last`, () => {
        expect(currentRoute()).toBeUndefined();
        expect(here(page.agents())).toBe(insidePath(`opened-last`, page.agents()));
    });
});

describe(`the route's readers`, () => {
    beforeAll(() => readRoutesOf(router));

    it(`read the frame, the page and the sandbox off the route`, async () => {
        await router.push(homePath(BOX, page.agent(`c1`)));
        const route = router.currentRoute.value;

        expect(frameOf(route)).toBe(`home`);
        expect(pageOf(route)).toBe(`agent`);
        expect(isPage(route, `agent`)).toBe(true);
        expect(isPage(route, `agents`)).toBe(false);
        expect(routeSandbox(route)).toBe(BOX);
    });

    it(`read Home's own page as Home's frame with no page, and a page outside the shell as no frame at all`, async () => {
        await router.push(homePath());
        expect(frameOf(router.currentRoute.value)).toBe(`home`);
        expect(pageOf(router.currentRoute.value)).toBeUndefined();
        expect(routeSandbox(router.currentRoute.value)).toBeUndefined();

        await router.push(`/login`);
        expect(frameOf(router.currentRoute.value)).toBeUndefined();
    });

    it(`make a link where the reader is: inside the sandbox on screen`, async () => {
        await router.push(insidePath(BOX, page.workspace(`src/a.ts`)));

        expect(here(page.agent(`c1`))).toBe(insidePath(BOX, page.agent(`c1`)));
        expect(here(page.account(`appearance`))).toBe(insidePath(BOX, page.account(`appearance`)));
    });

    it(`make a link where the reader is: in Home's frame, of the sandbox it shows, the account's pages needing none`, async () => {
        await router.push(homePath(BOX, page.agents()));

        expect(here(page.workspace())).toBe(homePath(BOX, page.workspace()));
        expect(here(page.account(`appearance`))).toBe(homePath(undefined, page.account(`appearance`)));
    });

    it(`make a link on Home's own page of the sandbox opened last, and Home itself with none known`, async () => {
        await router.push(homePath());
        expect(here(page.agents())).toBe(homePath(`opened-last`, page.agents()));

        activeSandboxId.value = undefined;
        expect(here(page.agents())).toBe(homePath());
        expect(here(page.account())).toBe(homePath(undefined, page.account()));
    });

    it(`make a link outside the shell inside the sandbox opened last, and an account page in Home's frame`, async () => {
        await router.push(`/login`);

        expect(here(page.agents())).toBe(insidePath(`opened-last`, page.agents()));
        expect(here(page.account())).toBe(homePath(undefined, page.account()));
    });

    it(`follow the route inside a computed, as a template reads them`, async () => {
        await router.push(insidePath(BOX, page.agents()));
        const link = computed(() => here(page.workspace()));
        expect(link.value).toBe(insidePath(BOX, page.workspace()));

        await router.push(homePath(BOX, page.agents()));
        expect(link.value).toBe(homePath(BOX, page.workspace()));
    });

    it(`make a link of another sandbox in the same frame`, async () => {
        await router.push(homePath(BOX, page.agents()));
        expect(hereIn(`other`, page.workspace())).toBe(homePath(`other`, page.workspace()));
        expect(hereIn(`other`, page.account())).toBe(insidePath(`other`, page.account()));

        await router.push(insidePath(BOX, page.agents()));
        expect(hereIn(`other`, page.workspace())).toBe(insidePath(`other`, page.workspace()));
    });

    it(`say whether the route shows a tile's page, below it included, whichever form its address is in`, async () => {
        await router.push(homePath(BOX, page.agent(`c1`)));
        const route = router.currentRoute.value;

        expect(routeShows(route, `/agents`)).toBe(true);
        expect(routeShows(route, insidePath(`other`, page.agents()))).toBe(true);
        expect(routeShows(route, `/workspace`)).toBe(false);
        expect(routeShows(route, `/agentsmith`)).toBe(false);
    });
});

describe(`in a desktop window on a folder`, () => {
    afterEach(() => {
        delete window.__INTENTIC_LOCAL__;
    });

    it(`writes the two pages it has at its own addresses, and any other where the shell has it`, () => {
        const inTheShell = here(page.agents());
        wearFace({ id: `f1`, name: `shop`, path: `/home/ada/shop` });

        expect(here(page.account(`keybindings`, { hash: `chords` }))).toBe(localPath(`account`, { tab: `keybindings` }, { hash: `chords` }));
        expect(here(page.workspace(`src/main.ts`))).toBe(localPath(`files`, { path: `src/main.ts` }));
        expect(here(page.agents())).toBe(inTheShell);
    });
});

describe(`the frames named outright`, () => {
    it(`are the shared table's addresses`, () => {
        expect(toInside(BOX)).toBe(`/s/${BOX}`);
        expect(toInside(BOX, page.agents())).toBe(`/s/${BOX}/agents`);
        expect(toHome()).toBe(`/home`);
        expect(toHome(BOX)).toBe(`/home/${BOX}`);
        expect(toHome(BOX, page.sandboxSettings())).toBe(`/home/${BOX}/settings`);
        expect(toFloating(BOX, `chat`)).toBe(`/s/${BOX}/floating/chat`);
        expect(toTop(`invite`, { token: `t1` })).toBe(`/invite/t1`);
        expect(toTop(`login`, {}, { returnTo: `/home` })).toBe(`/login?returnTo=%2Fhome`);
    });
});

describe(`an address read as its page`, () => {
    it(`reads either form, its query and hash kept`, () => {
        expect(linkOf(`/s/${BOX}/workspace/src/a.ts?agent=c1#L4`)).toEqual(page.workspace(`src/a.ts`, { query: { agent: `c1` }, hash: `L4` }));
        expect(linkOf(`/workspace/src/a.ts?agent=c1`)).toEqual(page.workspace(`src/a.ts`, { query: { agent: `c1` } }));
        expect(linkOf(`/home/account/appearance`)).toEqual(page.account(`appearance`));
        expect(linkOf(`/nowhere`)).toBeUndefined();
    });

    it(`tells a page below another, and one page from another`, () => {
        expect(pageCovers(page.agents(), page.agent(`c1`))).toBe(true);
        expect(pageCovers(page.workspace(`src`), page.workspace(`src/a.ts`))).toBe(true);
        expect(pageCovers(page.workspace(`src`), page.workspace(`srcs/a.ts`))).toBe(false);
        expect(samePage(page.extension(`crm`, `a`), page.extension(`crm`, `a`))).toBe(true);
        expect(samePage(page.extension(`crm`, `a`), page.extension(`crm`, `b`))).toBe(false);
    });
});
