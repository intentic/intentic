import { HOME_SEGMENT, homePath, insidePath, page, SANDBOX_PAGES, SANDBOX_SEGMENT } from "@intentic/sandbox-contract/app-routes";
import { createMemoryHistory, createRouter, type RouteRecordRaw } from "vue-router";
import { readRoutesOf, routeName } from "../../lib/routes/links";

/* Whether the rail is unrolled onto every sandbox is read off the address and nothing else: on Home's own page, on the
   account's pages opened from it and on any page of a sandbox in Home's frame, folded again by any address inside a
   sandbox. What stands beside the rail is the sandbox's own wherever a page of one is on screen, the rail unrolled or
   not. A real router, so Back is the router's own, and nothing a window remembers can make one address draw two screens. */

const view = { render: () => null };
const pages = [`chat`, `agents`, `workspace`, `sandboxSettings`] as const;
const router = createRouter({
    history: createMemoryHistory(),
    routes: [
        { path: `/home/account/:tab?`, name: routeName(`home`, `account`), meta: { frame: `home`, page: `account` }, component: view },
        { path: `/home/:sandbox?`, name: `home`, meta: { frame: `home` }, component: view },
        { path: `/s/:sandbox/account/:tab?`, name: routeName(`inside`, `account`), meta: { frame: `inside`, page: `account` }, component: view },
        ...pages.flatMap((name): RouteRecordRaw[] => [
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
        { path: `/login`, component: view },
    ],
});
readRoutesOf(router);

const { masterRail, sandboxBeside } = await import("./masterRail");

const BOX = `a1b2c3d4e5f6`;

beforeEach(async () => {
    await router.push(homePath(BOX));
});

it(`unrolls the rail on Home's own page, around no page of a sandbox`, () => {
    expect(masterRail.value).toBe(true);
    expect(sandboxBeside.value).toBe(false);
});

it(`keeps the rail unrolled on a sandbox's page, with the sandbox's own beside it as when folded`, async () => {
    await router.replace(homePath(BOX, page.workspace()));

    expect(masterRail.value).toBe(true);
    expect(sandboxBeside.value).toBe(true);
});

it(`treats the Chat as any other page of the sandbox`, async () => {
    await router.replace(homePath(BOX, page.chat()));

    expect(sandboxBeside.value).toBe(true);
});

it(`keeps the rail unrolled on a sandbox's settings, the sandbox's own beside it`, async () => {
    await router.push(homePath(BOX, page.sandboxSettings(`models`)));

    expect(masterRail.value).toBe(true);
    expect(sandboxBeside.value).toBe(true);
});

it(`folds the rail on any address inside a sandbox, the same page included, and moves nothing beside it`, async () => {
    await router.push(homePath(BOX, page.workspace()));

    await router.push(insidePath(BOX, page.workspace()));

    expect(masterRail.value).toBe(false);
    expect(sandboxBeside.value).toBe(true);
});

it(`keeps the rail on the person's own pages in Home's frame, around no page of a sandbox, and gives it back on them inside`, async () => {
    await router.push(homePath(undefined, page.account(`appearance`)));

    expect(masterRail.value).toBe(true);
    expect(sandboxBeside.value).toBe(false);

    await router.push(insidePath(BOX, page.account(`appearance`)));

    expect(masterRail.value).toBe(false);
});

it(`wears nothing of Home on a page outside the shell`, async () => {
    await router.push(`/login`);

    expect(masterRail.value).toBe(false);
});

// The audit's repro (2026-11-04): from inside a sandbox, out to Home, then Back. The frame was the window's memory, which
// Back did not restore, so the reader landed on the sandbox's page with Home's rail around it.
it(`steps Back out of Home onto the address inside the sandbox, in the sandbox's own frame`, async () => {
    await router.push(insidePath(BOX, page.agents()));
    expect(masterRail.value).toBe(false);

    await router.push(homePath(BOX));
    expect(masterRail.value).toBe(true);

    router.back();
    await new Promise<void>((resolve) => {
        const stop = router.afterEach(() => {
            stop();
            resolve();
        });
    });

    expect(router.currentRoute.value.fullPath).toBe(insidePath(BOX, page.agents()));
    expect(masterRail.value).toBe(false);
});
