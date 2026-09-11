import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDocumentProvider } from "../../../core-views/documentRegistry";
import { rowActionsFor, type RowActionSources } from "./rowActions";

// Composition rule for a tree row's icons: the one place git repos, directory-surface extensions, document providers
// and personas meet on the same row.

const sources = (over: Partial<RowActionSources> = {}): RowActionSources => ({
    repoDirs: new Set<string>(),
    manageableDirs: new Set<string>(),
    previewableDirs: new Set<string>(),
    personaDirs: new Map<string, number>(),
    checkDirs: new Map<string, { adopted: boolean; changed: boolean }>(),
    openHealth: vi.fn(),
    openDirectory: vi.fn(),
    openPersonas: vi.fn(),
    openPreview: vi.fn(),
    openChecks: vi.fn(),
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
    it(`gives an ordinary directory without personas no actions`, () => {
        expect(rowActionsFor(`intentic/_editor/web/src`, sources())).toEqual([]);
    });

    it(`gives a directory with personas its persona action`, () => {
        const source = sources({ personaDirs: new Map([[`intentic/_editor/web/src`, 1]]) });
        expect(rowActionsFor(`intentic/_editor/web/src`, source).map((action) => action.id)).toEqual([`personas`]);
    });

    it(`gives a repo its health, and a managed repo its cog`, () => {
        const actions = rowActionsFor(`intentic`, sources({ repoDirs: new Set([`intentic`]), manageableDirs: new Set([`intentic`]) }));
        expect(actions.map((action) => action.id)).toEqual([`health`, `directory`]);
    });

    // A repository's own checks are evidence the file exists, so they stand rather than waiting for a hover, and they
    // sit with what the folder CARRIES (personas) rather than with what can be done to it (preview, manage).
    it(`gives a repo that declares checks a standing shield, before the cog`, () => {
        const source = sources({
            repoDirs: new Set([`intentic`]),
            manageableDirs: new Set([`intentic`]),
            checkDirs: new Map([[`intentic`, { adopted: true, changed: false }]]),
        });
        const actions = rowActionsFor(`intentic`, source);
        expect(actions.map((action) => action.id)).toEqual([`health`, `checks`, `directory`]);
        const checks = actions.find((action) => action.id === `checks`);
        expect(checks?.standing).toBe(true);
        checks?.run();
        expect(source.openChecks).toHaveBeenCalledWith(`intentic`);
    });

    // The two states that are not "it runs": each has to be readable without opening the panel, since the point of the
    // switch is that a declaration nobody agreed to does nothing.
    it(`says whether declared checks are waiting or have changed under an adoption`, () => {
        const waiting = rowActionsFor(`shop`, sources({ checkDirs: new Map([[`shop`, { adopted: false, changed: false }]]) }));
        expect(waiting[0]?.tooltip).toBe(`This repository declares checks, not switched on`);
        const changed = rowActionsFor(`shop`, sources({ checkDirs: new Map([[`shop`, { adopted: false, changed: true }]]) }));
        expect(changed[0]?.tooltip).toBe(`Its checks changed since you switched them on, so they are not running`);
    });

    // Eye opens the Preview area, not another in-tree tab.
    it(`gives a previewable repo its eye, ahead of the cog`, () => {
        const source = sources({
            repoDirs: new Set([`shop`]),
            manageableDirs: new Set([`shop`]),
            previewableDirs: new Set([`shop`]),
        });
        const actions = rowActionsFor(`shop`, source);
        expect(actions.map((action) => action.id)).toEqual([`health`, `preview`, `directory`]);
        actions.find((action) => action.id === `preview`)?.run();
        expect(source.openPreview).toHaveBeenCalledWith(`shop`);
    });

    // Document leads the row, matching the rail's ordering, not appended after existing affordances.
    it(`puts a document ahead of the repo's own affordances`, () => {
        provider(`architecture`, `intentic`);
        const actions = rowActionsFor(`intentic`, sources({ repoDirs: new Set([`intentic`]) }));
        expect(actions.map((action) => action.id)).toEqual([`document:acme.docs:architecture`, `health`]);
    });

    // Documents are path-keyed, independent of repo/management status: a non-repo package can still have one.
    it(`offers a document on a package directory that is not a repo`, () => {
        provider(`architecture`, `intentic/_sandbox/acp-bridge`);
        const source = sources();
        const [action] = rowActionsFor(`intentic/_sandbox/acp-bridge`, source);
        expect(action?.tooltip).toContain(`architecture`);
        action?.run();
        expect(source.openDocument).toHaveBeenCalledWith(
            `acme.docs`,
            `architecture`,
            `intentic/_sandbox/acp-bridge`,
            `Architecture`,
            `question-circle`,
        );
    });

    // Icons show on hover, except an offer that is evidence (a page exists): hiding it would hide the fact. What you
    // can DO to a repo never stands.
    it(`lets an offer stand on the row, and never the repo's own affordances`, () => {
        provider(`architecture`, `intentic/_deploy/graph`, true);
        expect(rowActionsFor(`intentic/_deploy/graph`, sources()).map((action) => action.standing)).toEqual([true]);
        expect(
            rowActionsFor(`intentic`, sources({ repoDirs: new Set([`intentic`]), manageableDirs: new Set([`intentic`]) })).map(
                (action) => action.standing,
            ),
        ).toEqual([false, false]);
    });

    // A permanent-but-non-evidence offer (e.g. git history) still waits for hover like any other affordance.
    it(`leaves an offer that is not evidence on hover`, () => {
        provider(`history`, `intentic`);
        expect(rowActionsFor(`intentic`, sources()).map((action) => action.standing)).toEqual([false]);
    });

    // Persona icon stands (is evidence) once a folder has a persona, answering "which packages have one" without hover.
    // Empty folders show none.
    it(`stands on a folder that already has a persona, and is absent on one that has none`, () => {
        const withCards = sources({ personaDirs: new Map([[`intentic/_editor`, 1]]) });
        expect(rowActionsFor(`intentic/_editor`, withCards)[0]?.standing).toBe(true);
        expect(rowActionsFor(`intentic/_sandbox`, withCards)).toEqual([]);
    });

    // Several cards means a list behind the icon, not one card, so the tooltip states the count rather than leaving it
    // to the click.
    it(`says how many personas start here`, () => {
        const one = rowActionsFor(`docs`, sources({ personaDirs: new Map([[`docs`, 1]]) }))[0]?.tooltip ?? ``;
        const three = rowActionsFor(`docs`, sources({ personaDirs: new Map([[`docs`, 3]]) }))[0]?.tooltip ?? ``;
        expect(one).toContain(`1 persona`);
        expect(three).toContain(`3 personas`);
        expect(one).not.toBe(three);
    });

    it(`opens the panel for the folder that was clicked`, () => {
        const source = sources({ personaDirs: new Map([[`intentic/_editor/web`, 1]]) });
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
        expect(rowActionsFor(`intentic`, sources({ repoDirs: new Set([`intentic`]) })).map((action) => action.id)).toEqual([`health`]);
    });
});
