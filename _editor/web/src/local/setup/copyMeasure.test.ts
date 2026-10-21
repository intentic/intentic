import type { LocalFolderSetup, LocalProjectPreview } from "../../app/environments/localHost";
import { copyMeasureOf } from "./copyMeasure";

// A folder's first copy as its page measures it: from the sync's own word and counts, never from a guess.

const copying = (more: Partial<Pick<LocalFolderSetup, `status` | `copy`>> = {}): LocalFolderSetup => ({
    state: `copying`,
    name: `shop`,
    status: undefined,
    heldBy: [],
    made: true,
    hasLog: false,
    startedAt: undefined,
    ...more,
});

const ASKED: LocalProjectPreview = {
    kind: `new`,
    name: `shop`,
    path: `C:\\code\\shop`,
    files: 328,
    bytes: 3 * 1024 ** 2,
    more: false,
    large: false,
    cautions: [],
    signedIn: true,
    seconds: 169,
};

describe(`a folder's first copy, measured`, () => {
    it(`is a connection on its way before the sync says anything, carrying what the page counted before the press`, () => {
        expect(copyMeasureOf(copying(), ASKED)).toEqual({ percent: 0, step: `Connecting to the sandbox`, detail: `328 files · 3.0 MB` });
        expect(copyMeasureOf(copying({ status: `connecting-beta` })).detail).toBeUndefined();
    });

    it(`counts, then compares, before any file crosses, the sync's own count replacing the page's`, () => {
        const counted = copying({ status: `reconciling`, copy: { files: 330, bytes: 3 * 1024 ** 2 } });
        expect(copyMeasureOf(copying({ status: `scanning` }), ASKED)).toMatchObject({ percent: 1, step: `Counting files` });
        expect(copyMeasureOf(counted, ASKED)).toEqual({ percent: 2, step: `Comparing files`, detail: `330 files · 3.0 MB` });
    });

    it(`says how many files are in and how many bytes have crossed while they cross`, () => {
        const half = copying({ status: `staging-beta`, copy: { files: 328, bytes: 2_000_000, stagedFiles: 164, stagingFiles: 328, stagedBytes: 1_000_000 } });
        expect(copyMeasureOf(half)).toEqual({ percent: 50, step: `164 of 328 files`, detail: `977 KB of 1.9 MB` });
        expect(copyMeasureOf(copying({ status: `staging-beta`, copy: { stagedFiles: 0, stagingFiles: 1 } })).step).toBe(`0 of 1 file`);
    });

    it(`never says more crossed than there is, nor reaches the end before the sync does`, () => {
        const over = copying({ status: `staging-beta`, copy: { files: 2, bytes: 100, stagedFiles: 2, stagingFiles: 2, stagedBytes: 140 } });
        expect(copyMeasureOf(over)).toMatchObject({ percent: 97, detail: `100 B of 100 B` });
        expect(copyMeasureOf(copying({ status: `saving` })).percent).toBe(98);
        expect(copyMeasureOf(copying({ status: `transitioning` })).step).toBe(`Putting files in place`);
    });

    it(`says files are crossing, with no figure, where nothing counts them`, () => {
        expect(copyMeasureOf(copying({ status: `staging-beta` }))).toEqual({ percent: undefined, step: `Copying files`, detail: undefined });
    });
});
