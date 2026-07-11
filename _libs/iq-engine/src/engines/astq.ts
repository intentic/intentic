import { readFile } from "node:fs/promises";
import type { EngineHit, FileEntry } from "../types.js";
import { LANGUAGES, parseLang } from "../indexer/languages.js";
import { langOf } from "../workspace/scan.js";

const MAX_FILE_BYTES = 1024 * 1024;

// `iq ast '<pattern>'` — ast-grep metavariable pattern ($X one node, $$$ any) over files of one language,
// parsed live so results are never stale.
export const astSearch = async (pattern: string, lang: string, entries: readonly FileEntry[]): Promise<EngineHit[]> => {
    if (LANGUAGES[lang] === undefined) {
        throw new Error(`iq ast: unsupported --lang ${lang} (supported: ${Object.keys(LANGUAGES).join(", ")})`);
    }
    const hits: EngineHit[] = [];
    for (const entry of entries) {
        if (langOf(entry.path) !== lang || entry.size > MAX_FILE_BYTES) {
            continue;
        }
        const content = await readFile(entry.abs, "utf8").catch(() => undefined);
        if (content === undefined) {
            continue;
        }
        const root = parseLang(lang, content)?.root();
        if (root === undefined) {
            continue;
        }
        for (const node of root.findAll(pattern)) {
            const range = node.range();
            hits.push({
                path: entry.path,
                line: range.start.line + 1,
                text: node.text().split("\n", 1)[0]!.trim(),
                tags: [{ kind: "text" }],
            });
        }
    }
    return hits.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
};
