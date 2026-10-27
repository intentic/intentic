import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import { editFenceOf, fenceWrites, writesSomewhere } from "./editScope";

// Pins where a member may change files by hand: the daemon's edit fence (area-scope.ts `callerEditFence`) as folders.

const AREAS: Area[] = [
    { id: `docs`, folders: [`docs`] },
    { id: `web`, folders: [`apps/web`, `packages/ui`] },
];
const at = (fence: ReturnType<typeof editFenceOf>, ...paths: string[]): boolean[] => paths.map((path) => fenceWrites(fence, path));

describe(`canWriteAt's fence`, () => {
    it(`lets a writer with edit ["docs"] change docs/a.md and everything under docs, not src/b.ts nor the root`, () => {
        const fence = editFenceOf(`writer`, { edit: [`docs`] }, AREAS);
        expect(at(fence, `docs/a.md`, `docs`, `docs/deep/x.md`, `src/b.ts`, ``, `docs2/a.md`)).toEqual([true, true, true, false, false, false]);
    });

    it(`resolves an area to every folder it names`, () => {
        const fence = editFenceOf(`writer`, { edit: [`web`] }, AREAS);
        expect(at(fence, `apps/web/main.ts`, `packages/ui/button.ts`, `apps/api/main.ts`)).toEqual([true, true, false]);
    });

    it(`answers nowhere for edit "none", below the writer tier, and while the answer or the manifest is still on its way`, () => {
        const fences = [
            editFenceOf(`writer`, { edit: `none` }, AREAS),
            editFenceOf(`collaborator`, { edit: `all` }, AREAS),
            editFenceOf(`viewer`, undefined, AREAS),
            editFenceOf(`writer`, undefined, AREAS),
            editFenceOf(`writer`, { edit: [`docs`] }, undefined),
        ];
        expect(fences.map(writesSomewhere)).toEqual([false, false, false, false, false]);
        expect(fences.map((fence) => fenceWrites(fence, `docs/a.md`))).toEqual([false, false, false, false, false]);
    });

    it(`lets a maintainer and the owner change everything, and a writer with edit "all" everything they see`, () => {
        const fences = [editFenceOf(`maintainer`, undefined, undefined), editFenceOf(`owner`, undefined, undefined), editFenceOf(`writer`, { edit: `all` }, undefined)];
        expect(fences.map((fence) => at(fence, ``, `src/b.ts`))).toEqual([
            [true, true],
            [true, true],
            [true, true],
        ]);
    });
});
