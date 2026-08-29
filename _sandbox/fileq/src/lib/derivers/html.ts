import { readFile } from "node:fs/promises";
import { bodyOf, metaOf, parseHtml } from "@intentic/webq/dom";
import { renderMarkdown } from "@intentic/webq/markdown";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Local HTML files, through webq's own writer — the same DOM → markdown conventions a fetched page gets, but
 * with NO fit-pruning: a file in the workspace is there whole on purpose (an export, a report, a saved page),
 * and silently dropping its "chrome" would be editing a document nobody asked to have edited. Relative URLs
 * pass through untouched; there is no base URL a local file can honestly claim. */

export const htmlDeriver: Deriver = {
    name: "html",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const doc = parseHtml(await readFile(absPath, "utf8"));
        const body = bodyOf(doc);
        const meta = metaOf(doc);
        return {
            markdown: body === undefined ? "" : renderMarkdown(body),
            title: meta.title === "" ? undefined : meta.title,
            notes: [],
        };
    },
};
