import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { rankByFuzzy } from "@intentic/base/fuzzy";
import type { SqliteDb } from "@intentic/base/sqlite";
import { listFiles } from "../store/index-store.js";
import type { FileEntry } from "../types.js";
import { editDistance, type PathResolution, type VerifyLookup } from "./check.js";

// How many case-folded FTS hits are re-read for an exact-case spelling before a name counts as never written.
const MENTION_SCAN = 200;

const normalize = (raw: string): string => raw.replace(/\\/g, "/").replace(/^\.\//, "");

// The checks' view of one workspace: the sweep's admitted paths (so nothing the floor hides can ground a claim), the
// index for symbols and words, and the files themselves for line counts and positions. A file the index has not caught
// up with (the daemon re-indexes behind edits; an agent verifies right after making them) is read from disk instead,
// and its index rows are ignored, so a name just written counts and a name just deleted does not.
export const indexLookup = (db: SqliteDb, root: string, entries: readonly FileEntry[]): VerifyLookup => {
    const paths = entries.map((entry) => entry.path);
    const admitted = new Set(paths);
    const stored = listFiles(db);
    const stale = new Set(
        entries
            .filter((entry) => {
                const known = stored.get(entry.path);
                // The indexer's own already-indexed test, inverted (indexer.ts stores the rounded mtime).
                return known === undefined || known.size !== entry.size || known.mtimeMs !== Math.round(entry.mtimeMs);
            })
            .map((entry) => entry.path),
    );
    const texts = new Map<string, readonly string[] | undefined>();
    const linesOf = (path: string): readonly string[] | undefined => {
        if (!texts.has(path)) {
            let lines: string[] | undefined;
            try {
                lines = readFileSync(join(root, path), "utf8").split("\n");
                if (lines.at(-1) === "") {
                    lines.pop();
                }
            } catch {
                lines = undefined;
            }
            texts.set(path, lines);
        }
        return texts.get(path);
    };
    let names: string[] | undefined;

    // What the answer probably meant: the same file name elsewhere, else the nearest-named file in the deepest
    // directory of the cited path that exists (a made-up `src/gadget.ts` beside a real `src/widget.ts`), else fuzzy.
    const closestPath = (segments: readonly string[]): string | undefined => {
        const base = segments.at(-1) ?? "";
        const sameName = paths.find((candidate) => candidate === base || candidate.endsWith(`/${base}`));
        if (sameName !== undefined) {
            return sameName;
        }
        for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
            const dir = `${segments.slice(segments.length - 1 - depth, segments.length - 1).join("/")}/`;
            const siblings = paths.filter((candidate) => candidate.startsWith(dir) || candidate.includes(`/${dir}`));
            const limit = Math.max(3, Math.floor(base.length / 2));
            const ranked = siblings
                .filter((candidate) => !candidate.slice(candidate.lastIndexOf(dir) + dir.length).includes("/"))
                .map((candidate) => ({ candidate, distance: editDistance(base, candidate.slice(candidate.lastIndexOf("/") + 1), limit) }))
                .filter((entry) => entry.distance <= limit)
                .toSorted((a, b) => a.distance - b.distance || (a.candidate < b.candidate ? -1 : 1));
            if (ranked[0] !== undefined) {
                return ranked[0].candidate;
            }
        }
        return rankByFuzzy(segments.join("/"), paths)[0]?.path;
    };

    // Answers cite paths several ways: root-relative, absolute (sometimes from another checkout of the same repo), or
    // relative to a package. The longest tail that some admitted path ends with wins; a relative path keeps at least
    // two segments, so a bare `index.ts` tail cannot ground `src/made-up/index.ts`.
    const resolvePath = (raw: string): PathResolution => {
        let path = normalize(raw);
        let absoluteOutside = false;
        if (isAbsolute(path)) {
            const rel = relative(root, path);
            if (!rel.startsWith("..") && !isAbsolute(rel)) {
                path = rel;
            } else {
                absoluteOutside = true;
            }
        }
        if (admitted.has(path)) {
            return { status: "found", path };
        }
        const segments = path.split("/").filter((segment) => segment !== "" && segment !== "~");
        const floor = absoluteOutside || segments.length < 2 ? 1 : 2;
        for (let drop = absoluteOutside ? 1 : 0; segments.length - drop >= floor; drop += 1) {
            const tail = segments.slice(drop).join("/");
            const matches = paths.filter((candidate) => candidate === tail || candidate.endsWith(`/${tail}`));
            if (matches.length === 1) {
                return { status: "found", path: matches[0]! };
            }
            if (matches.length > 1) {
                return { status: "ambiguous" };
            }
        }
        const suggestion = closestPath(segments);
        return suggestion === undefined ? { status: "missing" } : { status: "missing", suggestion };
    };

    return {
        resolvePath,
        lineCount: (path) => linesOf(path)?.length,
        occurrences(path, name) {
            const lines = linesOf(path);
            if (lines === undefined) {
                return [];
            }
            const escaped = name.replace(/[$]/g, "\\$");
            const word = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
            const found: number[] = [];
            lines.forEach((text, index) => {
                if (word.test(text)) {
                    found.push(index + 1);
                }
            });
            return found;
        },
        // A body, not a container: a class spans everything it holds, so an anchor between two methods would cover both.
        enclosingSpan(path, line) {
            const row = db.get(
                `SELECT s.line AS start, s.end_line AS end FROM symbols s JOIN files f ON f.id = s.file_id
                 WHERE f.path = ? AND s.line <= ? AND s.end_line >= ? AND s.kind NOT IN ('class', 'type')
                 ORDER BY s.end_line - s.line LIMIT 1`,
                path,
                line,
                line,
            );
            return row === undefined ? undefined : { start: Number(row["start"]), end: Number(row["end"]) };
        },
        definitions(name) {
            return db
                .all(
                    `SELECT f.path AS path, s.line AS line FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? ORDER BY f.path, s.line`,
                    name,
                )
                .map((row) => ({ path: row["path"] as string, line: Number(row["line"]) }))
                .filter((definition) => admitted.has(definition.path) && !stale.has(definition.path));
        },
        mentioned(name) {
            // The FTS tokenizer keeps `_` and `$` inside tokens, so an identifier is one token; its matching is
            // case-folded, so the chunks it finds are re-read for the exact spelling (`fourOhFourFallback` is not
            // `fourOhFourFallBack`).
            if (!/^[\w$]+$/.test(name)) {
                return false;
            }
            const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`);
            const indexed = db
                .all(
                    `SELECT c.text AS text, f.path AS path FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
                     JOIN files f ON f.id = c.file_id WHERE chunks_fts MATCH ? LIMIT ?`,
                    `"${name}"`,
                    MENTION_SCAN,
                )
                .some((row) => {
                    const path = row["path"] as string;
                    return admitted.has(path) && !stale.has(path) && word.test(row["text"] as string);
                });
            return indexed || [...stale].some((path) => linesOf(path)?.some((text) => word.test(text)) === true);
        },
        closestName(name) {
            names ??= db.all(`SELECT DISTINCT name FROM symbols`).map((row) => row["name"] as string);
            const limit = Math.max(2, Math.floor(name.length / 3));
            let best: { name: string; distance: number } | undefined;
            for (const candidate of names) {
                const distance = editDistance(name.toLowerCase(), candidate.toLowerCase(), limit);
                if (distance <= limit && (best === undefined || distance < best.distance || (distance === best.distance && candidate < best.name))) {
                    best = { name: candidate, distance };
                }
            }
            return best?.name;
        },
    };
};
