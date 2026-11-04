import { HOME_SEGMENT, homePath, insidePath, page, topPath } from "@intentic/sandbox-contract/app-routes";
import { createMemoryHistory, createRouter, type RouteRecordRaw } from "vue-router";

/* The addresses from before frames, through the real route table: each lands on its page in the sandbox it names (else
   the one open, else the first the account lists), in the frame it was pressed in, or on arrival inside the sandbox for
   a page of one and in Home's frame for the account's own. Names the old routes had still resolve. */

const rows = [{ id: `first` }, { id: `second` }];
const list = jest.fn(async () => rows);
jest.mock("../client/sandbox/useSandbox", () => ({ useSandbox: () => ({ list }) }));

const { activeSandboxId } = await import("../app/storage/activeSandbox");
const { pageRoutes } = await import("./pageRoutes");
const { legacyRoutes } = await import("./legacyRoutes");
const { routeName } = await import("../lib/routes/links");

const view = { render: () => null };
const shell = (): RouteRecordRaw[] => [
    {
        path: topPath(`root`),
        component: view,
        children: [{ path: `${HOME_SEGMENT}/:sandbox?`, name: `home`, meta: { frame: `home` }, component: view }, ...pageRoutes(), ...legacyRoutes()],
    },
];
const routerAt = async (start?: string) => {
    const router = createRouter({ history: createMemoryHistory(), routes: shell() });
    if (start !== undefined) {
        await router.push(start);
    }
    return router;
};

const BOX = `a1b2c3d4e5f6`;

beforeEach(() => {
    activeSandboxId.value = BOX;
    list.mockClear();
});

describe(`an old address arriving`, () => {
    it.each([
        [`/agents/c1?sandbox=X`, insidePath(`X`, page.agent(`c1`))],
        [`/agents/c1`, insidePath(BOX, page.agent(`c1`))],
        [`/agents?focus=cnv_1`, insidePath(BOX, page.agents({ query: { focus: `cnv_1` } }))],
        [`/workspace/src/app.ts`, insidePath(BOX, page.workspace(`src/app.ts`))],
        [`/sandbox/models`, insidePath(BOX, page.sandboxSettings(`models`))],
        [`/sandbox`, insidePath(BOX, page.sandboxSettings())],
        [`/connect?provider=claude`, insidePath(BOX, page.sandboxSettings(`models`, { query: { provider: `claude` } }))],
        [`/sandbox/devices`, insidePath(BOX, page.devices())],
        [`/sandbox/audit`, insidePath(BOX, page.sandboxSettings(`activity`, { query: { section: `audit` } }))],
        [`/desktop`, insidePath(BOX, page.browsers(`desktop`))],
        [`/needs`, insidePath(BOX, page.agents())],
        [`/settings/appearance`, homePath(undefined, page.account(`appearance`))],
        [`/settings`, homePath(undefined, page.account())],
        [`/deleted-sandboxes`, homePath(undefined, page.deletedSandboxes())],
        [`/sandbox/deleted`, homePath(undefined, page.deletedSandboxes())],
    ])(`%s lands on %s`, async (old, landing) => {
        const router = await routerAt(old);
        expect(router.currentRoute.value.fullPath).toBe(landing);
    });

    it(`lands an old part of Settings on the section that holds it, at the part's anchor`, async () => {
        const router = await routerAt(`/settings/voice`);
        expect(router.currentRoute.value.name).toBe(routeName(`home`, `account`));
        expect(router.currentRoute.value.hash).toBe(`#voice`);
    });

    it(`opens the first sandbox the account lists when none is open`, async () => {
        activeSandboxId.value = undefined;
        list.mockImplementationOnce(async () => {
            activeSandboxId.value = `second`;
            return rows;
        });

        const router = await routerAt(`/workspace`);

        expect(list).toHaveBeenCalledTimes(1);
        expect(router.currentRoute.value.fullPath).toBe(insidePath(`second`, page.workspace()));
    });

    it(`has only Home to show for a sandbox's page when the account lists none`, async () => {
        activeSandboxId.value = undefined;
        list.mockImplementationOnce(async () => []);

        const router = await routerAt(`/agents`);

        expect(router.currentRoute.value.fullPath).toBe(homePath());
    });
});

describe(`an old address pressed in the app`, () => {
    it(`stays in Home's frame when pressed there, of the sandbox it shows`, async () => {
        const router = await routerAt(homePath(`other`, page.workspace()));

        await router.push(`/sandbox/models`);

        expect(router.currentRoute.value.fullPath).toBe(homePath(`other`, page.sandboxSettings(`models`)));
    });

    it(`keeps an account page inside the sandbox it was pressed in`, async () => {
        const router = await routerAt(insidePath(`other`, page.agents()));

        await router.push(`/settings/appearance`);

        expect(router.currentRoute.value.fullPath).toBe(insidePath(`other`, page.account(`appearance`)));
    });

    it(`opens the sandbox an old link names, in the frame it was pressed in`, async () => {
        const router = await routerAt(homePath(`other`));

        await router.push(`/sandbox/access?section=programs&sandbox=named#linked-sandboxes`);

        expect(router.currentRoute.value.fullPath).toBe(
            homePath(`named`, page.sandboxSettings(`access`, { query: { section: `programs` }, hash: `linked-sandboxes` })),
        );
    });

    // Every link is built from the table, so a location naming a route from before frames is a mistake to see at once,
    // not one to land quietly through an old address.
    it(`refuses a location by the name its route had before frames`, async () => {
        const router = await routerAt(insidePath(`other`, page.agents()));

        for (const name of [`workspace`, `sandbox`, `agent`, `settings`]) {
            await expect(Promise.resolve().then(() => router.push({ name }))).rejects.toThrow();
        }
        expect(router.currentRoute.value.fullPath).toBe(insidePath(`other`, page.agents()));
    });

    it(`replaces where the old address was asked to replace, so Back skips it`, async () => {
        const router = await routerAt(insidePath(`other`, page.agents()));
        await router.push(insidePath(`other`, page.workspace()));

        await router.replace(`/devices`);
        expect(router.currentRoute.value.fullPath).toBe(insidePath(`other`, page.devices()));

        router.back();
        await new Promise<void>((resolve) => {
            const stop = router.afterEach(() => {
                stop();
                resolve();
            });
        });
        expect(router.currentRoute.value.fullPath).toBe(insidePath(`other`, page.agents()));
    });
});

describe(`the table's own records`, () => {
    it(`names each page in each frame, with the frame and page on the record`, async () => {
        const router = await routerAt();
        const agents = router.resolve(homePath(BOX, page.agents()));
        expect(agents.name).toBe(routeName(`home`, `agents`));
        expect(agents.meta).toMatchObject({ frame: `home`, page: `agents` });
        const settings = router.resolve(insidePath(BOX, page.sandboxSettings(`models`)));
        expect(settings.name).toBe(routeName(`inside`, `sandboxSettings`));
        expect(settings.params).toMatchObject({ sandbox: BOX, tab: `models` });
    });

    it(`ranks the account's own pages in Home's frame above a sandbox named there`, async () => {
        const router = await routerAt();
        expect(router.resolve(homePath(undefined, page.account(`appearance`))).name).toBe(routeName(`home`, `account`));
        expect(router.resolve(homePath(undefined, page.deletedSandboxes())).name).toBe(routeName(`home`, `deletedSandboxes`));
        expect(router.resolve(homePath(BOX)).name).toBe(`home`);
    });
});
