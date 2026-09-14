import { readFile } from "node:fs/promises";
import { bodyOf, metaOf, parseHtml } from "@intentic/webq/dom";
import { renderMarkdown } from "@intentic/webq/markdown";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Local HTML files, through webq's own writer — the same DOM → markdown conventions a fetched page gets, but with NO fit-pruning. */

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
