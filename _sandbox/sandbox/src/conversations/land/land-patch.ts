import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { GitRunner } from "@intentic/base/git";
import { chunkPaths } from "../../git/changes/changes-index.js";

// Diff written straight to a file, never held as a string, since a giant patch would blow the git runner's output
// ceiling. Returns the file's size, since that's all callers ever wanted; zero advances the tip as landed.
export const writePatch = async (main: string, patchPath: string, range: readonly string[], git: GitRunner): Promise<number> => {
    // `--no-textconv`/`--no-ext-diff`: a patch converted for reading (this image routes every binary extension through
    // fileq) carries no bytes `git apply` can use, and a document's diff would come out empty and land as nothing.
    await git(main, ["diff", `--output=${patchPath}`, "--binary", "--no-textconv", "--no-ext-diff", "-M", ...range]);
    return (await stat(patchPath).catch(undefinedIfMissing))?.size ?? 0;
};

// A single change is the chunking unit: splitting a rename's source from its destination loses -M pairing.
// NUL cannot occur in a git path, so chunkPaths can budget each whole group before it is flattened for git.
// Concatenate on disk so a large binary patch never rides through the runner's stdout or the daemon's heap.
export const writeChangesPatch = async (
    main: string, patchPath: string, from: string, tip: string, changes: readonly { readonly paths: readonly string[] }[], git: GitRunner,
): Promise<number> => {
    await rm(patchPath, { force: true });
    let size = 0;
    for (const groups of chunkPaths(changes.map((change) => change.paths.join("\0")))) {
        const part = `${patchPath}.part`;
        size += await writePatch(main, part, [from, tip, "--", ...groups.flatMap((group) => group.split("\0"))], git);
        await pipeline(createReadStream(part), createWriteStream(patchPath, { flags: "a" }));
    }
    return size;
};
