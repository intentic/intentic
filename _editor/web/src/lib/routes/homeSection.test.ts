// What Home shows of every sandbox, as it is kept on this device: one of a sandbox's sections, read back from storage
// only when it is one, and the addresses that belong to it.

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

const { chooseHomeSection, homeSection, sectionOwns, storedHomeSection } = await import("./homeSection");
const KEY = `ui-home-section`;

beforeEach(() => local.clear());

describe(`a kept choice`, () => {
    it(`reads back the section chosen, with its look`, () => {
        const workspace = { id: `workspace`, to: `/workspace`, label: `Workspace`, icon: `file-tree` } as const;

        chooseHomeSection(workspace);

        expect(homeSection.value).toEqual(workspace);
        expect(storedHomeSection()).toEqual(workspace);
    });

    it(`keeps an extension's monogram`, () => {
        local.set(KEY, JSON.stringify({ id: `crm`, to: `/ext/crm/main`, label: `CRM`, monogram: `CR` }));

        expect(storedHomeSection()).toEqual({ id: `crm`, to: `/ext/crm/main`, label: `CRM`, monogram: `CR` });
    });

    it(`forgets it when the home conversation is chosen again`, () => {
        chooseHomeSection({ id: `agents`, to: `/agents`, label: `Agents` });

        chooseHomeSection(undefined);

        expect(homeSection.value).toBeUndefined();
        expect(local.has(KEY)).toBe(false);
    });

    it.each([
        [`text that is not JSON`, `workspace`],
        [`an address that is not a path`, JSON.stringify({ id: `workspace`, to: `workspace`, label: `Workspace` })],
        [`a section with no name`, JSON.stringify({ id: `workspace`, to: `/workspace`, label: `` })],
        [`a bare value`, JSON.stringify(`/workspace`)],
    ])(`is the home conversation for %s`, (_case, raw) => {
        local.set(KEY, raw);

        expect(storedHomeSection()).toBeUndefined();
    });

    it(`is the home conversation with nothing kept`, () => {
        expect(storedHomeSection()).toBeUndefined();
    });
});

describe(`the addresses a section owns`, () => {
    const workspace = { to: `/workspace` };

    it.each([`/workspace`, `/workspace/src/a.ts`, `/workspace?agent=cnv_1`, `/workspace/src/a.ts#L4`])(`%s is the Workspace's`, (address) => {
        expect(sectionOwns(workspace, address)).toBe(true);
    });

    it.each([`/workspaces`, `/agents`, `/home`, `/`])(`%s is not`, (address) => {
        expect(sectionOwns(workspace, address)).toBe(false);
    });

    it(`is nothing at all with no section chosen`, () => {
        expect(sectionOwns(undefined, `/workspace`)).toBe(false);
    });
});
