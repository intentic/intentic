import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDocumentProvider } from "../../core-views/documentRegistry";
import { rowActionsFor, type RowActionSources } from "./rowActions";

/* The composition rule for a tree row's icons. Worth a test because it is the one place four unrelated
 * contributors (git repos, directory-surface extensions, document providers, personas) meet on the same row, and
 * the thing that used to go wrong is silent: a row simply renders one icon fewer than it should. */

const sources = (over: Partial<RowActionSources> = {}): RowActionSources => ({
    repoDirs: new Set<string>(),
    manageableDirs: new Set<string>(),
    previewableDirs: new Set<string>(),
    personaDirs: new Map<string, number>(),
    openHealth: vi.fn(),
    openDirectory: vi.fn(),
    openPersonas: vi.fn(),
    openPreview: vi.fn(),
    openDocument: vi.fn(),
    ...over,
});

const disposables: { dispose(): void }[] = [];
const provider = (id: string, at: string, evidence = false) =>
    disposables[
        disposables.push(
            registerDocumentProvider({
                owner: `acme.docs`,
                id,
                label: `Architecture`,
                detect: (path) =>
                    path === at ? { icon: `question-circle`, tooltip: `Open architecture doc`, title: `Architecture`, evidence } : undefined,
                component: () => Promise.resolve({}),
            }),
        ) - 1
    ];

afterEach(() => {
    for (const disposable of disposables.splice(0)) {
        disposable.dispose();
    }
});

describe(`rowActionsFor`, () => {
    // Every folder can be given somebody to work in it, so that is the one offer an ordinary directory has.
    it(`gives an ordinary directory only its personas`, () => {
        expect(rowActionsFor(`intentic/_editor/web/src`, sources()).map((action) => action.id)).toEqual([`personas`]);
    });

    it(`gives a repo its health, and a managed repo its cog`, () => {
        const actions = rowActionsFor(`intentic`, sources({ repoDirs: new Set([`intentic`]), manageableDirs: new Set([`intentic`]) }));
        expect(actions.map((action) => action.id)).toEqual([`health`, `personas`, `directory`]);
    });

    // The eye is the Preview AREA's door, not another in-tree tab: a runnable repo used to open an iframe tab
    // here, and this is where that gesture went.
    it(`gives a previewable repo its eye, ahead of the cog`, () => {
        const source = sources({
            repoDirs: new Set([`shop`]),
            manageableDirs: new Set([`shop`]),
            previewableDirs: new Set([`shop`]),
        });
        const actions = rowActionsFor(`shop`, source);
        expect(actions.map((action) => action.id)).toEqual([`health`, `personas`, `preview`, `directory`]);
        actions.find((action) => action.id === `preview`)?.run();
        expect(source.openPreview).toHaveBeenCalledWith(`shop`);
    });

    // The document is what the directory IS, so it leads: the same narrowing the rail's order follows, rather
    // than the newcomer joining the end of the queue.
    it(`puts a document ahead of the repo's own affordances`, () => {
        provider(`architecture`, `intentic`);
        const actions = rowActionsFor(`intentic`, sources({ repoDirs: new Set([`intentic`]) }));
        expect(actions.map((action) => action.id)).toEqual([`document:acme.docs:architecture`, `health`, `personas`]);
    });

    // The whole point of the path-keyed contribution: a package deep inside a monorepo is not a repo and has no
    // management surface, but it can still have something to read.
    it(`offers a document on a package directory that is not a repo`, () => {
        provider(`architecture`, `intentic/_sandbox/acp-bridge`);
        const source = sources();
        const [action] = rowActionsFor(`intentic/_sandbox/acp-bridge`, source);
        expect(action?.tooltip).toBe(`Open architecture doc`);
        action?.run();
        expect(source.openDocument).toHaveBeenCalledWith(
            `acme.docs`,
            `architecture`,
            `intentic/_sandbox/acp-bridge`,
            `Architecture`,
            `question-circle`,
        );
    });

    /* WHICH ICONS SURVIVE THE POINTER BEING SOMEWHERE ELSE. A row's icons are revealed on hover, and an offer
     * that is evidence ("this package has a page") opts out of that: hiding it hides the fact, which is how a
     * documented monorepo came to look exactly like an undocumented one. What you can DO to a repo does not. */
    it(`lets an offer stand on the row, and never the repo's own affordances`, () => {
        provider(`architecture`, `intentic/_deploy/graph`, true);
        expect(rowActionsFor(`intentic/_deploy/graph`, sources()).map((action) => action.standing)).toEqual([true, false]);
        expect(
            rowActionsFor(`intentic`, sources({ repoDirs: new Set([`intentic`]), manageableDirs: new Set([`intentic`]) })).map(
                (action) => action.standing,
            ),
        ).toEqual([false, false, false]);
    });

    // An offer every directory of its kind gets (a repo always has git history) says nothing by being permanent,
    // so it waits for the pointer like the affordances beside it.
    it(`leaves an offer that is not evidence on hover`, () => {
        provider(`history`, `intentic`);
        expect(rowActionsFor(`intentic`, sources()).map((action) => action.standing)).toEqual([false, false]);
    });

    /* THE PERSONA ICON IS EVIDENCE ONCE THERE IS ONE: "which of these packages has its own persona" is a
     * question about the tree, and a hover-only glyph answers it for nobody. An empty folder's stays hidden with
     * the rest of what you can DO. */
    it(`stands on a folder that already has a persona, and hides on one that has none`, () => {
        const withCards = sources({ personaDirs: new Map([[`intentic/_editor`, 1]]) });
        expect(rowActionsFor(`intentic/_editor`, withCards)[0]?.standing).toBe(true);
        expect(rowActionsFor(`intentic/_sandbox`, withCards)[0]?.standing).toBe(false);
    });

    /* A folder holds SEVERAL cards, and the count is the reason to expect a list behind the icon rather than one
     * card, so the tooltip carries it rather than saying "personas" and leaving the number to the click. */
    it(`says how many personas start here`, () => {
        expect(rowActionsFor(`docs`, sources())[0]?.tooltip).toBe(`Choose who works here`);
        expect(rowActionsFor(`docs`, sources({ personaDirs: new Map([[`docs`, 1]]) }))[0]?.tooltip).toBe(`Change who works here: 1 persona`);
        expect(rowActionsFor(`docs`, sources({ personaDirs: new Map([[`docs`, 3]]) }))[0]?.tooltip).toBe(`Change who works here, 3 personas`);
    });

    it(`opens the panel for the folder that was clicked`, () => {
        const source = sources();
        rowActionsFor(`intentic/_editor/web`, source)[0]?.run();
        expect(source.openPersonas).toHaveBeenCalledWith(`intentic/_editor/web`);
    });

    it(`drops a provider whose detect throws, keeping the rest of the row`, () => {
        vi.spyOn(console, `error`).mockImplementation(() => {});
        disposables.push(
            registerDocumentProvider({
                owner: `acme.broken`,
                id: `boom`,
                label: `Broken`,
                detect: () => {
                    throw new Error(`nope`);
                },
                component: () => Promise.resolve({}),
            }),
        );
        expect(rowActionsFor(`intentic`, sources({ repoDirs: new Set([`intentic`]) })).map((action) => action.id)).toEqual([`health`, `personas`]);
    });
});
