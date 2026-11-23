import { realpath, stat } from "node:fs/promises";
import { isInside } from "@intentic/base/contained";
import { undefinedIfMissing } from "@intentic/base/errors";
import { PAGE_MEDIA_MAX, PAGE_MEDIA_REF, type PageMediaFile } from "@intentic/sandbox-contract/text/pages";
import {
    extensionOf,
    holdsStreamedMedia,
    isStreamedExtension,
    STREAMED_MEDIA_TYPES,
} from "../../workspace/files/stored/stored-page-media.js";

// Video and audio a shown page plays from disk. A take is tens of megabytes, far past what a page can carry inside itself
// the way it carries pictures (page-assets.ts), so when the page is shown each file it names is recorded instead: its real
// path, type, size and modification time, in a manifest the stored page keeps (sandbox-contract text/pages.ts), and the
// reference in the page becomes `intentic-media:<n>`. The reader's chat mints a ticket for that one page and streams
// each file from GET /pages/media/{ticket}/{n} in byte ranges (page-media.routes.ts), so a player seeks at full quality
// without a byte of the file passing through the page.
//
// A file is served only while it is still the one that was shown: same real path, size and modification time, its bytes
// still the format its name says. A page is a record of what the reader saw beside what the agent said about it, and a
// take re-rendered under the same name would quietly turn "take 2 flickers" into a sentence about another video; the
// overwritten file is refused instead, and the agent shows a new page for the new take.
//
// Media is named only from the workspace and the showing turn's own checkout, never /tmp: under the turn's jail its /tmp
// is its own, so the daemon's /tmp is not where the agent rendered anything. And the manifest is signed: it is text in
// the records, which an agent or anyone who writes the workspace can edit, so only one the daemon wrote for that very page
// is ever served. The key, the signature and the checks on a file are kept below the agent
// (workspace/files/stored/stored-page-media.ts), so a runner can serve a page's media and its parent re-sign it.

export interface MediaTally {
    // The files recorded to stream, in the order their references number them.
    readonly media: readonly PageMediaFile[];
    // The same files as the page named them, in that order, for telling the agent.
    readonly mediaNamed: readonly string[];
    // Video and audio the page names that will not play, each with why.
    readonly mediaRefused: readonly { readonly ref: string; readonly reason: string }[];
}

// One page's media as it is carried: each file checked and recorded once however often the page names it, numbered in
// the order first named. `roots` are the folders a page may name media from: the workspace and the turn's own checkout.
export const mediaRecorder = (roots: readonly string[]) => {
    const recorded = new Map<string, { readonly index: number; readonly file: PageMediaFile; readonly named: string }>();
    const refused = new Map<string, string>();

    const refuse = (named: string, reason: string): undefined => {
        refused.set(named, reason);
        return undefined;
    };

    // The reference the page holds in place of `file` (as the page named it, `named`), or undefined, the reason kept.
    const recordNow = async (file: string, named: string): Promise<string | undefined> => {
        const extension = extensionOf(file);
        if (!isStreamedExtension(extension)) {
            return refuse(named, `not a video or audio format a browser plays (${Object.keys(STREAMED_MEDIA_TYPES).join(", ")})`);
        }
        // allow(silent-catch): a file that cannot be resolved is refused, with the reason the agent can act on.
        const real = await realpath(file).catch(() => undefined);
        if (real === undefined) {
            return refuse(named, "no such file");
        }
        if (!roots.some((root) => isInside(root, real))) {
            return refuse(named, "outside the workspace and your own checkout, the only places a page streams video and audio from");
        }
        const known = recorded.get(real);
        if (known !== undefined) {
            return `${PAGE_MEDIA_REF}${known.index}`;
        }
        const info = await stat(real).catch(undefinedIfMissing);
        if (info === undefined || !info.isFile()) {
            return refuse(named, "not a file");
        }
        if (!(await holdsStreamedMedia(real))) {
            return refuse(named, `its bytes are not ${extension.toUpperCase()}, whatever its name says`);
        }
        if (recorded.size >= PAGE_MEDIA_MAX) {
            return refuse(named, `a page streams at most ${PAGE_MEDIA_MAX} video and audio files`);
        }
        const index = recorded.size;
        recorded.set(real, { index, file: { path: real, type: STREAMED_MEDIA_TYPES[extension], size: info.size, mtimeMs: info.mtimeMs }, named });
        return `${PAGE_MEDIA_REF}${index}`;
    };

    // One at a time, in the order the page names them: carrying asks for every reference at once, and numbering in the
    // order their checks happened to finish made a page's first take index 1 on one showing and 0 on the next.
    let queue: Promise<unknown> = Promise.resolve();
    const record = (file: string, named: string): Promise<string | undefined> => {
        const next = queue.then(() => recordNow(file, named));
        // allow(silent-catch): the failure is the caller's, through `next`; the queue only waits for it to settle.
        queue = next.catch(() => undefined);
        return next;
    };

    const tally = (): MediaTally => {
        const ordered = [...recorded.values()].toSorted((a, b) => a.index - b.index);
        return {
            media: ordered.map((entry) => entry.file),
            mediaNamed: ordered.map((entry) => entry.named),
            mediaRefused: [...refused].map(([ref, reason]) => ({ ref, reason })),
        };
    };

    return { record, tally };
};
