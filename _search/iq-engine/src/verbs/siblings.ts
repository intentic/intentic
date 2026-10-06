import { pathTokens, queryTokens } from "../plan/tokens.js";
import type { FileEntry, RankedGroup } from "../types.js";
import { classOf } from "../workspace/scan.js";

// SIBLINGS: the files beside the answer, named in one capsule line. Mined 2026-10-06 over ~640 sessions: the first iq
// query named the file the session went on to edit 20% of the time, but that file's DIRECTORY 58% of the time. iq lands
// in the right folder and names the wrong neighbour (ChatImageThumb.vue answered, picturePeek.ts edited), so the
// neighbours are listed where the reader can pick one without listing the folder.

// What counts as a neighbour worth naming: source and its tests, not the folder's docs, configs or assets.
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|kts|rb|php|cs|cpp|cc|c|h|hpp|swift|scala|ex|exs|css|scss|less)$/;
// Names shown before the rest are counted; the line is a pointer, not a listing.
export const SIBLINGS_SHOWN = 6;

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

// How many of the query's words a file's name is made of: picturePeek.ts names "picture" and "peek".
const nameOverlap = (path: string, tokens: readonly string[]): number => {
    const parts = pathTokens(basename(path).replace(/\.[^.]+$/, ""));
    return tokens.filter((token) => parts.some((part) => part.startsWith(token) || token.startsWith(part))).length;
};

// The answer file's neighbours: ranked ones first in their rank order (the reader has evidence for them), then by how
// much of the query their name holds, then by name. Undefined when the answer sits at the root or alone.
export const siblingsLine = (answer: string, entries: readonly FileEntry[], ranked: readonly RankedGroup[], query: string): string | undefined => {
    const slash = answer.lastIndexOf("/");
    if (slash === -1) {
        return undefined;
    }
    const dir = answer.slice(0, slash + 1);
    const siblings = entries
        .map((entry) => entry.path)
        .filter((path) => path !== answer && path.startsWith(dir) && !path.slice(dir.length).includes("/") && CODE_FILE.test(path) && classOf(path) !== "docs");
    if (siblings.length === 0) {
        return undefined;
    }
    const rank = new Map(ranked.map((group, index) => [group.path, index]));
    const tokens = queryTokens(query);
    const ordered = siblings.toSorted(
        (a, b) =>
            (rank.get(a) ?? Number.POSITIVE_INFINITY) - (rank.get(b) ?? Number.POSITIVE_INFINITY) ||
            nameOverlap(b, tokens) - nameOverlap(a, tokens) ||
            (a < b ? -1 : a > b ? 1 : 0),
    );
    const shown = ordered.slice(0, SIBLINGS_SHOWN).map(basename);
    const rest = ordered.length - shown.length;
    return `siblings: ${shown.join(" · ")}${rest > 0 ? ` · +${rest} more` : ""}`;
};
