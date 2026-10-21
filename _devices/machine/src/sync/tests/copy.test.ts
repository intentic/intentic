import { copyOf } from "../report.js";

// A folder's page measures its first copy by these counts, so each is what Mutagen said and nothing guessed.
describe("copyOf", () => {
    it("says nothing before either end has scanned or received", () => {
        expect(copyOf(undefined)).toBeUndefined();
        expect(copyOf({ status: "connecting-beta", alpha: {}, beta: {} })).toBeUndefined();
    });

    it("counts the folder this device sends once it has scanned it, a zero Mutagen leaves out read as zero", () => {
        expect(copyOf({ status: "reconciling", alpha: { scanned: true, files: 328, totalFileSize: 3_145_728 }, beta: { scanned: true } })).toEqual({
            files: 328,
            bytes: 3_145_728,
            stagedFiles: undefined,
            stagingFiles: undefined,
            stagedBytes: undefined,
        });
        expect(copyOf({ status: "scanning", alpha: { scanned: true }, beta: {} })?.files).toBe(0);
    });

    it("reads how far the sandbox has staged this pass while it receives", () => {
        const copy = copyOf({
            status: "staging-beta",
            alpha: { scanned: true, files: 328, totalFileSize: 3_145_728 },
            beta: { scanned: true, stagingProgress: { receivedFiles: 142, expectedFiles: 328, totalReceivedSize: 1_200_000 } },
        });
        expect(copy).toEqual({ files: 328, bytes: 3_145_728, stagedFiles: 142, stagingFiles: 328, stagedBytes: 1_200_000 });
    });

    // A two-way session pulling the sandbox's changes down stages on this device: the sandbox is the sender then.
    it("takes the end Mutagen says is staging as the one receiving", () => {
        const copy = copyOf({
            status: "staging-alpha",
            alpha: { scanned: true, files: 9, stagingProgress: { receivedFiles: 1, expectedFiles: 4 } },
            beta: { scanned: true, files: 12, totalFileSize: 40 },
        });
        expect(copy).toEqual({ files: 12, bytes: 40, stagedFiles: 1, stagingFiles: 4, stagedBytes: 0 });
    });
});
