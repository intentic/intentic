import { page } from "@intentic/sandbox-contract/app-routes";

// What Home shows of every sandbox, as it is kept on this device: one of a sandbox's sections by its page, read back
// from storage only when it is one (a choice an older build kept as an address included), and the pages that belong to
// it.

// The node test environment has no storage.
const local = new Map<string, string>();
Object.defineProperty(globalThis, `localStorage`, {
    configurable: true,
    value: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => void local.set(key, value),
        removeItem: (key: string) => void local.delete(key),
        clear: () => local.clear(),
    },
});

const { chooseHomeSection, homeSection, sameSection, sectionPageOf, showsSection, storedHomeSection } = await import("./homeSection");
const KEY = `ui-home-section`;

const WORKSPACE = { id: `workspace`, page: { name: `workspace`, params: {} }, label: `Workspace`, icon: `file-tree` } as const;

beforeEach(() => local.clear());

describe(`a kept choice`, () => {
    it(`reads back the section chosen, with its look`, () => {
        chooseHomeSection(WORKSPACE);

        expect(homeSection.value).toEqual(WORKSPACE);
        expect(storedHomeSection()).toEqual(WORKSPACE);
    });

    it(`keeps an extension's view and monogram`, () => {
        local.set(KEY, JSON.stringify({ id: `crm`, page: { name: `extension`, params: { ext: `crm`, key: `main` } }, label: `CRM`, monogram: `CR` }));

        expect(storedHomeSection()).toEqual({
            id: `crm`,
            page: { name: `extension`, params: { ext: `crm`, key: `main` } },
            label: `CRM`,
            monogram: `CR`,
        });
    });

    it(`reads a choice an older build kept as its address`, () => {
        local.set(KEY, JSON.stringify({ id: `crm`, to: `/ext/crm/main`, label: `CRM`, monogram: `CR` }));
        expect(storedHomeSection()).toEqual({
            id: `crm`,
            page: { name: `extension`, params: { ext: `crm`, key: `main` } },
            label: `CRM`,
            monogram: `CR`,
        });

        local.set(KEY, JSON.stringify({ id: `workspace`, to: `/workspace`, label: `Workspace`, icon: `file-tree` }));
        expect(storedHomeSection()).toEqual(WORKSPACE);
    });

    it(`forgets it when the home conversation is chosen again`, () => {
        chooseHomeSection({ id: `agents`, page: { name: `agents`, params: {} }, label: `Agents` });

        chooseHomeSection(undefined);

        expect(homeSection.value).toBeUndefined();
        expect(local.has(KEY)).toBe(false);
    });

    it.each([
        [`text that is not JSON`, `workspace`],
        [`an address that is not a path`, JSON.stringify({ id: `workspace`, to: `workspace`, label: `Workspace` })],
        [`an address that is no page of a sandbox`, JSON.stringify({ id: `settings`, to: `/settings/appearance`, label: `Settings` })],
        [`an address no build routes`, JSON.stringify({ id: `old`, to: `/nowhere`, label: `Old` })],
        [`a page that is no sandbox's`, JSON.stringify({ id: `account`, page: { name: `account`, params: {} }, label: `Settings` })],
        [`a section with no name`, JSON.stringify({ id: `workspace`, page: { name: `workspace`, params: {} }, label: `` })],
        [`a bare value`, JSON.stringify(`/workspace`)],
    ])(`is the home conversation for %s`, (_case, raw) => {
        local.set(KEY, raw);

        expect(storedHomeSection()).toBeUndefined();
    });

    it(`is the home conversation with nothing kept`, () => {
        expect(storedHomeSection()).toBeUndefined();
    });
});

describe(`the pages a section owns`, () => {
    it.each([page.workspace(), page.workspace(`src/a.ts`), page.workspace(`src/a.ts`, { query: { agent: `cnv_1` }, hash: `L4` })])(
        `%o is the Workspace's`,
        (link) => {
            expect(showsSection(WORKSPACE, link)).toBe(true);
        },
    );

    it.each([page.agents(), page.chat(), page.sandboxSettings(`workspace`)])(`%o is not`, (link) => {
        expect(showsSection(WORKSPACE, link)).toBe(false);
    });

    it(`gives the board the agents opened from it, and an extension's view only its own`, () => {
        const board = { page: { name: `agents`, params: {} } } as const;
        expect(showsSection(board, page.agent(`cnv_1`))).toBe(true);
        const crm = { page: { name: `extension`, params: { ext: `crm` } } } as const;
        expect(showsSection(crm, page.extension(`crm`, `main`))).toBe(true);
        expect(showsSection(crm, page.extension(`erp`, `main`))).toBe(false);
    });

    it(`tells two views of one extension apart, and finds a tile's page in either form of its address`, () => {
        expect(
            sameSection(
                { page: { name: `extension`, params: { ext: `crm`, key: `a` } } },
                { page: { name: `extension`, params: { ext: `crm`, key: `b` } } },
            ),
        ).toBe(false);
        expect(sameSection(WORKSPACE, { page: { name: `workspace`, params: {} } })).toBe(true);
        expect(sameSection(WORKSPACE, undefined)).toBe(false);
        expect(sectionPageOf(`/ext/crm/main`)).toEqual({ name: `extension`, params: { ext: `crm`, key: `main` } });
        expect(sectionPageOf(`/s/a1b2c3d4e5f6/browsers`)).toEqual({ name: `browsers`, params: {} });
        expect(sectionPageOf(`/settings`)).toBeUndefined();
    });
});
