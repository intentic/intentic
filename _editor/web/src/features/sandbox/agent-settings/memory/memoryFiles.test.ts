// Which AGENTS.md files Settings shows, and which of them a turn would leave out: the same root-first ceiling the daemon
// applies (agent/prompt/workspace-memory.ts), worked out from the sizes the tree already carries.
import { MEMORY_MAX_CHARS } from "@intentic/constants";
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { memoryFilesIn } from "./memoryFiles";

const file = (path: string, size: number): WorkspaceTreeEntry => ({ name: path.split(`/`).at(-1) ?? path, path, type: `file`, size });
const dir = (path: string, children?: readonly WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: path.split(`/`).at(-1) ?? path,
    path,
    type: `dir`,
    children,
});

it(`lists the root's first, then each folder's, and nothing that is only named like one`, () => {
    const tree = [
        dir(`shop`, [file(`shop/AGENTS.md`, 10), file(`shop/AGENTS.md.bak`, 10), dir(`shop/web`, [file(`shop/web/AGENTS.md`, 10)])]),
        dir(`docs`, [file(`docs/agents.md`, 10)]),
        file(`AGENTS.md`, 10),
    ];

    expect(memoryFilesIn(tree).map(({ path, folder }) => [path, folder])).toEqual([
        [`AGENTS.md`, ``],
        [`shop/AGENTS.md`, `shop`],
        [`shop/web/AGENTS.md`, `shop/web`],
    ]);
});

it(`does not look into a folder the walk left unread`, () => {
    expect(memoryFilesIn([dir(`node_modules`)])).toEqual([]);
});

it(`drops a folder's file that would cross the ceiling on top of the root's, and never the root's for it`, () => {
    const tree = [file(`AGENTS.md`, MEMORY_MAX_CHARS - 100), dir(`shop`, [file(`shop/AGENTS.md`, 200)]), dir(`blog`, [file(`blog/AGENTS.md`, 50)])];

    expect(memoryFilesIn(tree).map(({ path, dropped }) => [path, dropped])).toEqual([
        [`AGENTS.md`, false],
        [`blog/AGENTS.md`, false],
        [`shop/AGENTS.md`, true],
    ]);
});

it(`drops a root file that is over the ceiling alone, and lets a folder's take the room it left`, () => {
    const files = memoryFilesIn([file(`AGENTS.md`, MEMORY_MAX_CHARS + 1), dir(`shop`, [file(`shop/AGENTS.md`, 500)])]);

    expect(files.map(({ dropped }) => dropped)).toEqual([true, false]);
    expect(files[0]?.share).toBeGreaterThan(100);
    expect(files[1]?.share).toBe(2.5);
});

it(`counts only the folders on the way down, not a sibling's file`, () => {
    const tree = [dir(`a`, [file(`a/AGENTS.md`, MEMORY_MAX_CHARS)]), dir(`b`, [file(`b/AGENTS.md`, MEMORY_MAX_CHARS)])];

    expect(memoryFilesIn(tree).map(({ dropped }) => dropped)).toEqual([false, false]);
});
