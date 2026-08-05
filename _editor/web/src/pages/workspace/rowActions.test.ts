import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDocumentProvider } from "../../core-views/documentRegistry";
import { rowActionsFor, type RowActionSources } from "./rowActions";

/* The composition rule for a tree row's icons. Worth a test because it is the one place three unrelated
 * contributors — git repos, directory-surface extensions, document providers — meet on the same row, and the
 * thing that used to go wrong is silent: a row simply renders one icon fewer than it should. */

const sources = (over: Partial<RowActionSources> = {}): RowActionSources => ({
    repoDirs: new Set<string>(),
    manageableDirs: new Set<string>(),
    openHealth: vi.fn(),
    openDirectory: vi.fn(),
    openDocument: vi.fn(),
    ...over,
});

const disposables: { dispose(): void }[] = [];
const provider = (id: string, at: string) =>
    disposables[
        disposables.push(
            registerDocumentProvider({
                owner: `acme.docs`,
                id,
                label: `Architecture`,
                detect: (path) => (path === at ? { icon: `question-circle`, tooltip: `Open architecture doc`, title: `Architecture` } : undefined),
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
    it(`gives an ordinary directory nothing`, () => {
        expect(rowActionsFor(`intentic/_editor/web/src`, sources())).toEqual([]);
    });

    it(`gives a repo its health, and a managed repo its cog`, () => {
        const actions = rowActionsFor(`intentic`, sources({ repoDirs: new Set([`intentic`]), manageableDirs: new Set([`intentic`]) }));
        expect(actions.map((action) => action.id)).toEqual([`health`, `directory`]);
    });

    // The document is what the directory IS, so it leads — the same narrowing the rail's order follows, rather
    // than the newcomer joining the end of the queue.
    it(`puts a document ahead of the repo's own affordances`, () => {
        provider(`architecture`, `intentic`);
        const actions = rowActionsFor(`intentic`, sources({ repoDirs: new Set([`intentic`]) }));
        expect(actions.map((action) => action.id)).toEqual([`document:acme.docs:architecture`, `health`]);
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
        expect(rowActionsFor(`intentic`, sources({ repoDirs: new Set([`intentic`]) })).map((action) => action.id)).toEqual([`health`]);
    });
});
