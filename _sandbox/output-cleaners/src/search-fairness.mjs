// Per-file sampling for whole grep/rg outputs, before hit-prefix folding and the generic cap.
import { bodyBytes, IMPORTANT, invocation } from "./cleaner-shapes.mjs";
import { MAX, LOG_MAX_BYTES } from "./output-cap.mjs";

// Parse only a whole search result, including context separators and heading mode. Unknown lines fail open.
export const SEARCH_COMMAND = invocation("rg|grep");
const parseSearchLine = (line, heading, command) => {
    const match = /^(.*?)([:-])(\d+)\2(.*)$/.exec(line);
    if (match !== null && match[1] !== "" && !/^\d+$/.test(match[1])) {
        return { path: match[1], hit: match[2] === ":" };
    }
    const local = heading === undefined ? null : /^(\d+)([:-])(.*)$/.exec(line);
    if (local !== null) {
        return { path: heading, hit: local[2] === ":" };
    }
    if (command.includes("--heading") && !/\s/.test(line)) {
        return { path: line };
    }
    return undefined;
};

const searchFiles = (lines, command) => {
    if (!SEARCH_COMMAND.test(command)) {
        return undefined;
    }
    const files = new Map();
    let heading;
    for (const line of lines) {
        if (line === "" || line === "--") {
            continue;
        }
        const parsed = parseSearchLine(line, heading, command);
        if (parsed === undefined) {
            return undefined;
        }
        heading = parsed.path;
        if (!files.has(heading)) {
            files.set(heading, []);
        }
        if (parsed.hit !== undefined) {
            files.get(heading).push({ line, hit: parsed.hit });
        }
    }
    return files.size === 0 ? undefined : files;
};

const sampleSearchEntries = (entries, format, rawBytes) => {
    let added = true;
    for (let index = 0; added; index++) {
        added = false;
        for (const entry of entries) {
            if (index >= entry.candidates.length || entry.kept.includes(entry.candidates[index])) {
                added ||= index < entry.candidates.length;
                continue;
            }
            entry.kept.push(entry.candidates[index]);
            const next = format();
            if (next.length > MAX || bodyBytes(next) > LOG_MAX_BYTES || bodyBytes(next) >= rawBytes) {
                entry.kept.pop();
            } else {
                added = true;
            }
        }
    }
};

// Spend one slot per file per pass. Metadata names even files that cannot fit a hit in this output.
export const fairSearch = (lines, command) => {
    if (lines.length <= MAX && bodyBytes(lines) <= LOG_MAX_BYTES) {
        return lines;
    }
    const files = searchFiles(lines, command);
    if (files === undefined) {
        return lines;
    }
    const entries = [...files].map(([path, rows]) => ({
        path,
        rows,
        hits: rows.filter((row) => row.hit).length,
        kept: [],
        candidates: [...rows.filter((row) => row.hit), ...rows.filter((row) => !row.hit)],
    }));
    const format = () => {
        const out = entries
            .filter((entry) => entry.kept.length > 0)
            .flatMap(({ path, hits, kept }) => [
                `${path}: ${hits} hits, ${kept.filter((row) => row.hit).length} shown`,
                ...kept.map((row) => row.line),
            ]);
        const unshown = new Map();
        for (const entry of entries.filter((candidate) => candidate.kept.length === 0)) {
            if (!unshown.has(entry.hits)) {
                unshown.set(entry.hits, []);
            }
            unshown.get(entry.hits).push(entry.path);
        }
        if (unshown.size > 0) {
            out.push(`Files (0 shown): ${[...unshown].map(([hits, paths]) => `${hits} hits each: ${paths.join(", ")}`).join("; ")}`);
        }
        return out;
    };
    // If even the file names exceed the byte budget, the ordinary cap and retrieval pointer handle the overflow.
    if (bodyBytes(format()) > LOG_MAX_BYTES) {
        return lines;
    }
    for (const entry of entries) {
        for (const row of entry.rows.filter((candidate) => IMPORTANT.test(candidate.line))) {
            entry.kept.push(row);
        }
    }
    if (format().length > MAX || bodyBytes(format()) > LOG_MAX_BYTES) {
        return lines;
    }
    sampleSearchEntries(entries, format, bodyBytes(lines));
    for (const entry of entries) {
        entry.kept.sort((left, right) => entry.rows.indexOf(left) - entry.rows.indexOf(right));
    }
    const out = format();
    return bodyBytes(out) >= bodyBytes(lines) ? lines : out;
};
