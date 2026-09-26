import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { coverChoices, coverIn, coverIndex, coverRank, coversBelow } from "./homeCover";

const file = (path: string, extra: Partial<WorkspaceTreeEntry> = {}): WorkspaceTreeEntry => ({
    name: path.slice(path.lastIndexOf(`/`) + 1),
    path,
    type: `file`,
    ...extra,
});
const dir = (path: string, extra: Partial<WorkspaceTreeEntry> = {}): WorkspaceTreeEntry => ({
    name: path.slice(path.lastIndexOf(`/`) + 1),
    path,
    type: `dir`,
    children: [],
    ...extra,
});

describe(`which file answers for a cover name`, () => {
    it(`ranks the exact spelling over another capitalisation`, () => {
        expect(coverRank(`README.md`, `README.md`)).toBe(0);
        expect(coverRank(`readme.md`, `README.md`)).toBe(1);
        expect(coverRank(`Package.json`, `package.json`)).toBe(1);
    });

    it(`matches a document's stem in another notation, markdown first`, () => {
        expect(coverRank(`README.markdown`, `README.md`)).toBe(3);
        expect(coverRank(`README.rst`, `README.md`)).toBe(5);
        expect(coverRank(`readme.txt`, `README.md`)).toBe(9);
        expect(coverRank(`README`, `README.md`)).toBe(10);
        expect(coverRank(`LICENSE.md`, `LICENSE`)).toBe(2);
    });

    it(`keeps everything that is not a document to its own name`, () => {
        expect(coverRank(`package.yaml`, `package.json`)).toBeUndefined();
        expect(coverRank(`Cargo.lock`, `Cargo.toml`)).toBeUndefined();
        expect(coverRank(`README.html`, `README.md`)).toBeUndefined();
        expect(coverRank(`CHANGELOG.md`, `README.md`)).toBeUndefined();
    });

    it(`reads a bare name as a document only when it is capitalised whole`, () => {
        expect(coverRank(`Dockerfile.md`, `Dockerfile`)).toBeUndefined();
        expect(coverRank(`makefile.txt`, `Makefile`)).toBeUndefined();
        expect(coverRank(`NOTICE.txt`, `NOTICE`)).toBe(9);
    });

    it(`takes the best file a folder has, not the first it lists`, () => {
        const listing = [file(`web/readme.txt`), file(`web/README.rst`), file(`web/README.md`), dir(`web/src`)];
        expect(coverIn(listing, `README.md`)?.path).toBe(`web/README.md`);
        expect(coverIn(listing.slice(0, 2), `README.md`)?.path).toBe(`web/README.rst`);
        expect(coverIn([file(`web/b/readme.MD`), file(`web/b/README.MD`)], `README.md`)?.path).toBe(`web/b/README.MD`);
    });

    it(`never answers with a folder or a link that goes nowhere`, () => {
        expect(coverIn([dir(`web/README.md`)], `README.md`)).toBeUndefined();
        expect(coverIn([file(`web/README.md`, { link: { to: `../gone.md`, state: `broken` } })], `README.md`)).toBeUndefined();
        expect(coverIn([], `README.md`)).toBeUndefined();
    });
});

describe(`the names worth offering`, () => {
    it(`offers what recurs across folders, most folders first`, () => {
        const files = [
            file(`README.md`),
            file(`web/README.md`),
            file(`web/package.json`),
            file(`api/package.json`),
            file(`api/README.md`),
            file(`api/Dockerfile`),
            file(`docs/README.md`),
        ];
        expect(coverChoices(files, 8)).toEqual([
            { name: `README.md`, folders: 4 },
            { name: `package.json`, folders: 2 },
        ]);
    });

    it(`counts a document's notations as one name, offered in the spelling most folders use`, () => {
        const files = [file(`a/README.md`), file(`b/README.md`), file(`c/readme.rst`), file(`d/README`)];
        expect(coverChoices(files, 8)).toEqual([{ name: `README.md`, folders: 4 }]);
    });

    it(`counts a folder once however many spellings it holds, and leaves out archives and empty files`, () => {
        const files = [
            file(`a/README.md`),
            file(`a/readme.txt`),
            file(`b/site.zip`),
            file(`c/site.zip`),
            file(`d/NOTES.md`),
            file(`e/.gitkeep`, { size: 0 }),
            file(`f/.gitkeep`, { size: 0 }),
        ];
        expect(coverChoices(files, 8)).toEqual([]);
    });

    it(`stops at the limit`, () => {
        const files = [`a`, `b`].flatMap((folder) => [file(`${folder}/one.json`), file(`${folder}/two.json`), file(`${folder}/three.json`)]);
        expect(coverChoices(files, 2).map((choice) => choice.name)).toEqual([`one.json`, `three.json`]);
    });
});

describe(`where the loaded tree knows of covers`, () => {
    const files = [
        file(`README.md`),
        file(`packages/web/README.md`),
        file(`packages/api/readme.md`),
        file(`packages/api/src/deep/README.md`),
        file(`packages/cli/index.ts`),
    ];
    const index = coverIndex(files, `README.md`);

    it(`marks the folders holding one and counts those strictly below each folder`, () => {
        expect([...index.held].toSorted()).toEqual([``, `packages/api`, `packages/api/src/deep`, `packages/web`]);
        expect(index.below.get(``)).toBe(3);
        expect(index.below.get(`packages`)).toBe(3);
        expect(index.below.get(`packages/api`)).toBe(1);
        expect(index.below.get(`packages/web`)).toBeUndefined();
    });

    it(`lists the nearest folders below first, and none of the folder itself`, () => {
        expect(coversBelow(index, `packages`, 6)).toEqual([`packages/api`, `packages/web`, `packages/api/src/deep`]);
        expect(coversBelow(index, ``, 2)).toEqual([`packages/api`, `packages/web`]);
        expect(coversBelow(index, `packages/web`, 6)).toEqual([]);
    });

    it(`leaves out the folders the caller says a reader cannot reach, and counts nothing for them`, () => {
        const kept = coverIndex(files, `README.md`, (folder) => !folder.startsWith(`packages/api`));
        expect([[...kept.held].toSorted(), kept.below.get(`packages`), kept.below.get(`packages/api`)]).toEqual([[``, `packages/web`], 1, undefined]);
    });

    it(`does not read a sibling that shares a prefix as below`, () => {
        const near = coverIndex([file(`app/README.md`), file(`apple/README.md`)], `README.md`);
        expect(coversBelow(near, `app`, 6)).toEqual([]);
    });
});
