import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { type ProjectFocus, projectFocusRows, projectIdsOf } from "../projectFocus";

// Pins where the project scope is chosen in the tree: a repository's own row narrows to it, the background widens back.

const repo: WorkspaceTreeEntry = { name: `shop`, path: `shop`, type: `dir`, children: [] };
const folder: WorkspaceTreeEntry = { name: `src`, path: `shop/src`, type: `dir`, children: [] };
const file: WorkspaceTreeEntry = { name: `README.md`, path: `shop/README.md`, type: `file` };

const focusOn = (current?: string): ProjectFocus & { readonly chosen: (string | undefined)[] } => {
    const chosen: (string | undefined)[] = [];
    return { projects: projectIdsOf([`root`, `shop`, `apps/web`]), current, focus: (project) => chosen.push(project), chosen };
};

describe(`projectFocusRows`, () => {
    it(`offers a repository's row the narrowing, and runs it with that repository`, () => {
        const focus = focusOn();
        const { head, tail } = projectFocusRows(repo, false, focus);
        expect(tail).toEqual([]);
        expect(head).toHaveLength(1);
        head[0]?.command?.({} as never);
        expect(focus.chosen).toEqual([`shop`]);
    });

    it(`offers nothing on a plain folder, a file, or a selection of several`, () => {
        expect(projectFocusRows(folder, false, focusOn())).toEqual({ head: [], tail: [] });
        expect(projectFocusRows(file, false, focusOn())).toEqual({ head: [], tail: [] });
        expect(projectFocusRows(repo, true, focusOn())).toEqual({ head: [], tail: [] });
    });

    it(`never treats the workspace's own repository as a project`, () => {
        expect(projectFocusRows({ name: `root`, path: `root`, type: `dir`, children: [] }, false, focusOn())).toEqual({ head: [], tail: [] });
    });

    it(`offers the open project no narrowing to itself`, () => {
        expect(projectFocusRows(repo, false, focusOn(`shop`)).head).toEqual([]);
    });

    it(`widens back from the background while a project is open, and says nothing there otherwise`, () => {
        expect(projectFocusRows(undefined, false, focusOn())).toEqual({ head: [], tail: [] });
        const focus = focusOn(`shop`);
        const { tail } = projectFocusRows(undefined, false, focus);
        expect(tail).toHaveLength(1);
        tail[0]?.command?.({} as never);
        expect(focus.chosen).toEqual([undefined]);
    });
});
