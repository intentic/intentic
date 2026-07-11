import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { describe, expect, it, vi } from "vitest";

// The composable half pulls the sandbox client (browser-only window.env); only the pure walk is under test.
vi.mock(`../../composables/workspace/useWorkspaceTree`, () => ({ useWorkspaceTree: () => ({}) }));
vi.mock(`../../composables/sandboxClient`, () => ({ sandboxJson: () => Promise.resolve({}) }));
const { vitestProjects } = await import(`./useVitest`);

const file = (path: string): WorkspaceTreeEntry => ({ name: path.split(`/`).at(-1) ?? path, path, type: `file` });
const dir = (path: string, children: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: path.split(`/`).at(-1) ?? path,
    path,
    type: `dir`,
    children,
});

// One repo mirroring the real shapes: a config package, a config-less package whose tests sit in src/, a
// package with neither, and root-level evidence above any nested package.json.
const tree: WorkspaceTreeEntry[] = [
    dir(`repositories`, [
        dir(`repositories/mono`, [
            file(`repositories/mono/package.json`),
            dir(`repositories/mono/_libs`, [
                dir(`repositories/mono/_libs/engine`, [
                    file(`repositories/mono/_libs/engine/package.json`),
                    file(`repositories/mono/_libs/engine/vitest.config.ts`),
                ]),
                dir(`repositories/mono/_libs/sandbox`, [
                    file(`repositories/mono/_libs/sandbox/package.json`),
                    dir(`repositories/mono/_libs/sandbox/src`, [file(`repositories/mono/_libs/sandbox/src/panels.test.ts`)]),
                ]),
                dir(`repositories/mono/_libs/ui`, [file(`repositories/mono/_libs/ui/package.json`)]),
            ]),
        ]),
        dir(`repositories/plain`, [file(`repositories/plain/package.json`), file(`repositories/plain/vitest.config.ts`)]),
    ]),
];

describe(`vitestProjects`, () => {
    it(`attributes evidence to the nearest package.json dir: configs, nested test files; packages without evidence excluded`, () => {
        expect(vitestProjects(tree, `mono`)).toEqual([`repositories/mono/_libs/engine`, `repositories/mono/_libs/sandbox`]);
    });

    it(`detects the repo root itself when evidence sits at the top level`, () => {
        expect(vitestProjects(tree, `plain`)).toEqual([`repositories/plain`]);
    });

    it(`returns [] for an unknown repo`, () => {
        expect(vitestProjects(tree, `missing`)).toEqual([]);
    });
});
