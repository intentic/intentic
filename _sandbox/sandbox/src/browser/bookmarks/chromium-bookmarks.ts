import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { BookmarkNode } from "@intentic/sandbox-contract/schemas/bookmarks";
import { z } from "zod";

// What Chromium itself kept in a persistent profile (`<profile>/Default/Bookmarks`, a JSON file it rewrites whole), read
// once to seed that profile's own tree (bookmarks-store.ts): the bar's to the bar, the rest (Chromium's "other" and its
// mobile folder) to the other bookmarks. Only read, never written: the person's window keeps its own copy, and the tree
// here is the one the editor draws.

// Chromium's clock: microseconds since 1601-01-01, written as a decimal string.
const EPOCH_DELTA_MS = 11_644_473_600_000n;

const timeOf = (written: string | undefined, fallback: number): number => {
    if (written === undefined || !/^\d+$/.test(written) || written === "0") {
        return fallback;
    }
    return Number(BigInt(written) / 1000n - EPOCH_DELTA_MS);
};

interface ChromiumNode {
    readonly type: string;
    readonly name?: string | undefined;
    readonly url?: string | undefined;
    readonly date_added?: string | undefined;
    readonly children?: readonly ChromiumNode[] | undefined;
}

// Read loosely: a field this build does not know is ignored, and a node of a kind it does not know is skipped.
const ChromiumNodeSchema: z.ZodType<ChromiumNode> = z.lazy(() =>
    z.object({
        type: z.string(),
        name: z.string().optional(),
        url: z.string().optional(),
        date_added: z.string().optional(),
        children: z.array(ChromiumNodeSchema).optional(),
    }),
);

const ChromiumBookmarksSchema = z.object({
    roots: z.object({
        bookmark_bar: ChromiumNodeSchema.optional(),
        other: ChromiumNodeSchema.optional(),
        synced: ChromiumNodeSchema.optional(),
    }),
});

// Only pages a person could go back to; Chromium's own pages (`chrome://`) and scripts (`javascript:`) stay behind.
const keepable = (url: string): boolean => /^(?:https?|file|ftp):/i.test(url);

/**
 * Chromium's bookmarks under one of its roots, as this tree's nodes inside `parent`, depth first; ids are minted with
 * `mint`. A folder that holds nothing keepable is kept anyway: a person made it.
 */
const convert = (node: ChromiumNode, parent: string, now: number, mint: () => string, out: BookmarkNode[]): void => {
    for (const child of node.children ?? []) {
        const added = timeOf(child.date_added, now);
        if (child.type === "url" && child.url !== undefined && keepable(child.url)) {
            out.push({ id: mint(), kind: "url", title: child.name ?? child.url, url: child.url, parent, added });
        } else if (child.type === "folder") {
            const id = mint();
            out.push({ id, kind: "folder", title: child.name ?? "", parent, added });
            convert(child, id, now, mint, out);
        }
    }
};

/** The profile's own bookmarks as tree nodes (roots excluded), or undefined where Chromium kept none. */
export const readChromiumBookmarks = async (profileDir: string, now: number, mint: () => string): Promise<BookmarkNode[] | undefined> => {
    const text = await readFile(join(profileDir, "Default", "Bookmarks"), "utf8").catch(undefinedIfMissing);
    if (text === undefined) {
        return undefined;
    }
    const parsed = ChromiumBookmarksSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
        throw new Error(`Chromium's Bookmarks file is not in a shape this build reads: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }
    const { bookmark_bar: bar, other, synced } = parsed.data.roots;
    const nodes: BookmarkNode[] = [];
    if (bar !== undefined) {
        convert(bar, "bar", now, mint, nodes);
    }
    if (other !== undefined) {
        convert(other, "other", now, mint, nodes);
    }
    // The mobile folder, kept as a folder of the other bookmarks under its own name, when it holds anything.
    if (synced !== undefined && (synced.children?.length ?? 0) > 0) {
        const id = mint();
        nodes.push({ id, kind: "folder", title: synced.name ?? "Mobile bookmarks", parent: "other", added: timeOf(synced.date_added, now) });
        convert(synced, id, now, mint, nodes);
    }
    return nodes;
};
