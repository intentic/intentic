import type { NameRef, PathRef, Reference } from "./extract.js";

// The four ways an answer's reference can fail to hold against the workspace.
export type VerifyIssueKind = "missing-file" | "past-end" | "drifted-anchor" | "unknown-name";

export interface VerifyIssue {
    // 1-based line of the answer the reference sits on.
    readonly line: number;
    readonly kind: VerifyIssueKind;
    // The reference as the answer wrote it.
    readonly ref: string;
    readonly message: string;
}

export interface VerifyReport {
    // Distinct paths, anchored ranges and names that were checked.
    readonly files: number;
    readonly anchors: number;
    readonly names: number;
    readonly issues: readonly VerifyIssue[];
}

export type PathResolution =
    | { readonly status: "found"; readonly path: string }
    // A tail several files end with (`index.ts` in a monorepo): real, but which one is not knowable, so no line check.
    | { readonly status: "ambiguous" }
    | { readonly status: "missing"; readonly suggestion?: string };

// Everything the checks need to know about the workspace; the engine backs it with the index and the file tree.
export interface VerifyLookup {
    resolvePath(raw: string): PathResolution;
    lineCount(path: string): number | undefined;
    // 1-based lines of `path` on which `name` occurs as a whole word.
    occurrences(path: string, name: string): readonly number[];
    // The innermost function-like symbol whose body spans `line`, so an anchor at a function's head covers what the
    // function does; classes and types are containers and never count.
    enclosingSpan(path: string, line: number): { readonly start: number; readonly end: number } | undefined;
    definitions(name: string): readonly { readonly path: string; readonly line: number }[];
    // Whether the name occurs as a word anywhere in the indexed workspace: a call into a library the repo really uses
    // is grounded even though nothing here defines it.
    mentioned(name: string): boolean;
    closestName(name: string): string | undefined;
}

// How far outside an anchor's range (and its enclosing symbol) a name may sit before the line number reads as drifted.
export const DRIFT_TOLERANCE = 15;

const anchorText = (ref: PathRef, path: string): string => `${path}:${ref.start}${ref.end !== undefined ? `-${ref.end}` : ""}`;

const shortList = (lines: readonly number[], path: string): string => {
    const shown = lines.slice(0, 3).map((line) => `${path}:${line}`);
    return lines.length > 3 ? `${shown.join(", ")} (+${lines.length - 3} more)` : shown.join(", ");
};

export const verifyReferences = (refs: readonly Reference[], lookup: VerifyLookup): VerifyReport => {
    const issues: VerifyIssue[] = [];
    const resolved = new Map<PathRef, string>();
    const files = new Set<string>();
    const anchors = new Set<string>();
    const reportedPaths = new Set<string>();
    for (const ref of refs) {
        if (ref.kind !== "path") {
            continue;
        }
        const resolution = lookup.resolvePath(ref.path);
        if (resolution.status === "missing") {
            files.add(ref.path);
            if (!reportedPaths.has(ref.path)) {
                reportedPaths.add(ref.path);
                const hint = resolution.suggestion === undefined ? "" : `; closest: ${resolution.suggestion}`;
                issues.push({ line: ref.line, kind: "missing-file", ref: ref.path, message: `no such file in this workspace${hint}` });
            }
            continue;
        }
        if (resolution.status === "ambiguous") {
            files.add(ref.path);
            continue;
        }
        files.add(resolution.path);
        resolved.set(ref, resolution.path);
        if (ref.start === undefined) {
            continue;
        }
        const anchor = anchorText(ref, resolution.path);
        if (anchors.has(anchor)) {
            continue;
        }
        anchors.add(anchor);
        const length = lookup.lineCount(resolution.path);
        if (length !== undefined && ref.start > length) {
            issues.push({ line: ref.line, kind: "past-end", ref: anchor, message: `the file has ${length} lines` });
        }
    }

    // Drift: the names an answer line cites beside an anchor say where the anchor should point. An anchor drifted when
    // its file holds some of those names and none of them sits inside the cited range, its enclosing symbol, or the
    // tolerance band around it. One near name clears it: a correct anchor's subject is near, while a line may also
    // mention, in passing, code the same file holds far away. Names the file lacks may describe code elsewhere, and a
    // line citing one file at several lines is not judged: which name belongs to which anchor is a guess there, and a
    // false "drifted" costs more trust than a missed one.
    const byLine = Map.groupBy(refs, (ref) => ref.line);
    for (const lineRefs of byLine.values()) {
        const names = [...new Set(lineRefs.filter((ref): ref is NameRef => ref.kind === "name" && !ref.inCode).map((ref) => ref.name))];
        if (names.length === 0) {
            continue;
        }
        const lineAnchors = lineRefs.filter((ref): ref is PathRef => ref.kind === "path" && ref.start !== undefined && resolved.has(ref));
        const perFile = Map.groupBy(lineAnchors, (anchor) => resolved.get(anchor)!);
        for (const anchor of lineAnchors) {
            const path = resolved.get(anchor)!;
            if (perFile.get(path)!.length > 1) {
                continue;
            }
            const held = names.map((name) => ({ name, lines: lookup.occurrences(path, name) })).filter((entry) => entry.lines.length > 0);
            if (held.length === 0) {
                continue;
            }
            const start = anchor.start!;
            const end = anchor.end ?? start;
            const span = lookup.enclosingSpan(path, start);
            const isNear = (line: number): boolean =>
                (line >= start - DRIFT_TOLERANCE && line <= end + DRIFT_TOLERANCE) || (span !== undefined && line >= span.start && line <= span.end);
            if (held.some((entry) => entry.lines.some(isNear))) {
                continue;
            }
            const { name, lines } = held[0]!;
            const defined = lookup
                .definitions(name)
                .filter((definition) => definition.path === path)
                .map((definition) => definition.line);
            issues.push({
                line: anchor.line,
                kind: "drifted-anchor",
                ref: anchorText(anchor, path),
                message: `\`${name}\` is at ${shortList(defined.length > 0 ? defined : lines, path)}, not near line ${start}`,
            });
        }
    }

    // Names: defined somewhere, or at least written somewhere; neither means the answer made it up.
    const checkedNames = new Set<string>();
    for (const ref of refs) {
        if (ref.kind !== "name" || ref.plain === true || checkedNames.has(ref.name)) {
            continue;
        }
        checkedNames.add(ref.name);
        if (lookup.definitions(ref.name).length > 0 || lookup.mentioned(ref.name)) {
            continue;
        }
        const closest = lookup.closestName(ref.name);
        const hint = closest === undefined ? "" : `; closest: ${closest}`;
        issues.push({ line: ref.line, kind: "unknown-name", ref: ref.raw, message: `defined nowhere and written nowhere in this workspace${hint}` });
    }

    return {
        files: files.size,
        anchors: anchors.size,
        names: checkedNames.size,
        issues: issues.toSorted((a, b) => a.line - b.line || a.ref.localeCompare(b.ref)),
    };
};

const LABEL: Record<VerifyIssueKind, string> = {
    "missing-file": "missing file",
    "past-end": "past the end",
    "drifted-anchor": "drifted anchor",
    "unknown-name": "unknown name",
};

// A capsule line in iq's style, then one line per issue; `source` names what was checked (a file, or stdin).
export const renderVerify = (report: VerifyReport, source: string): string => {
    const counted = `${report.files} files, ${report.anchors} anchors, ${report.names} names checked`;
    if (report.files + report.anchors + report.names === 0) {
        return `iq verify: ${source} · nothing to check: no file paths, path:line anchors or code names found\n`;
    }
    if (report.issues.length === 0) {
        return `iq verify: ${source} · ${counted} · grounded\n`;
    }
    const head = `iq verify: ${source} · ${counted} · ${report.issues.length} ${report.issues.length === 1 ? "issue" : "issues"}`;
    const width = Math.max(...report.issues.map((issue) => `L${issue.line}`.length));
    const rows = report.issues.map((issue) => `${`L${issue.line}`.padEnd(width)}  ${LABEL[issue.kind].padEnd(14)}  ${issue.ref} — ${issue.message}`);
    return `${[head, ...rows].join("\n")}\n`;
};

// Levenshtein distance with an early exit once every cell of a row exceeds `limit`.
export const editDistance = (a: string, b: string, limit: number): number => {
    if (Math.abs(a.length - b.length) > limit) {
        return limit + 1;
    }
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        let rowBest = i;
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
            current.push(value);
            rowBest = Math.min(rowBest, value);
        }
        if (rowBest > limit) {
            return limit + 1;
        }
        previous = current;
    }
    return previous[b.length]!;
};
