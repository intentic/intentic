import { bodyBytes } from "./cleaner-shapes.mjs";

// cargo/rustc compiler output, read as diagnostics: errors with their spans first, repeated warnings one line each.
// 2026-11-19, the shinobi-society audit: agents piped cargo's output through `grep -E` hundreds of times to find the
// errors under pages of warnings, and the same warning block reached them sixty times over. A warning printed once stays
// verbatim; one printed again (a lint over many call sites, a workspace-wide manifest warning, the lib and its test
// target) becomes a single line with its count and where it was. Nothing else moves, and output with no rustc
// diagnostic in it (no `--> file:line:col` span under an `error:`/`warning:` header) comes back as it was.

// A diagnostic's first line: `error[E0308]: …`, `warning: …`, a clippy lint's `warning: …`.
const HEADER = /^(error|warning)(?:\[[\w-]+\])?: \S/;
// Where it points: ` --> src/lib.rs:3:9`.
const SPAN = /^\s*--> (\S+:\d+:\d+)\s*$/;
// The body under a header: indented, a gutter (`3 |`), a sub-diagnostic (`note:`, `help:`), an elision (`...`).
const BODY = /^(?:\s|\d+\s*\||note:|help:|\.\.\.|=)/;
// cargo's own progress, right-aligned and so indented like a body line, but never one.
const CARGO_STATUS =
    /^\s{0,12}(?:Compiling|Checking|Finished|Running|Fresh|Building|Blocking|Downloaded|Downloading|Updating|Locking|Adding|Documenting|Doc-tests|Executable|Installing|Installed|Packaging|Verifying|Archiving|Uploading|Removing|Updated|Unpacking|Waiting|Scraping|Generated)\s/;
// How many places a folded warning names before it counts the rest.
const SHOWN_SPANS = 3;

const isBody = (line) => line !== "" && BODY.test(line) && !CARGO_STATUS.test(line);

// The lines as runs: each diagnostic a block of its header and body, with the blank line that ends it; every other line
// a block of its own.
const blocksOf = (lines) => {
    const blocks = [];
    for (let index = 0; index < lines.length; ) {
        const header = HEADER.exec(lines[index]);
        if (header === null) {
            blocks.push({ lines: [lines[index]] });
            index += 1;
            continue;
        }
        let end = index + 1;
        while (end < lines.length && isBody(lines[end])) {
            end += 1;
        }
        const body = lines.slice(index, end);
        const span = body.map((line) => SPAN.exec(line)?.[1]).find((found) => found !== undefined);
        // The blank line rustc ends every diagnostic with travels with it, so a folded one leaves no gap behind.
        const trailing = lines[end] === "" ? 1 : 0;
        blocks.push({ lines: lines.slice(index, end + trailing), kind: header[1], header: lines[index], span });
        index = end + trailing;
    }
    return blocks;
};

// One line for a warning seen more than once: its header, how often, and the distinct places it named.
const foldedLine = (header, group) => {
    const spans = [...new Set(group.flatMap((block) => (block.span === undefined ? [] : [block.span])))];
    if (spans.length === 0) {
        return `${header} (×${group.length})`;
    }
    const more = spans.length > SHOWN_SPANS ? `, +${spans.length - SHOWN_SPANS} more` : "";
    return `${header} (×${group.length} at ${spans.slice(0, SHOWN_SPANS).join(", ")}${more})`;
};

/** Errors that point at code first, each warning printed more than once folded to one line; lines unchanged when neither applies. */
export const foldRustDiagnostics = (lines) => {
    const blocks = blocksOf(lines);
    if (!blocks.some((block) => block.span !== undefined)) {
        return lines;
    }
    const warnings = Map.groupBy(
        blocks.filter((block) => block.kind === "warning"),
        (block) => block.header,
    );
    const errors = blocks.filter((block) => block.kind === "error" && block.span !== undefined);
    const rest = blocks.filter((block) => !errors.includes(block));
    // Errors move only when something else comes before one: output that already leads with them stays in its order.
    const reordered = errors.length > 0 && blocks.slice(0, errors.length).some((block) => !errors.includes(block));
    const folded = [...warnings.values()].some((group) => group.length > 1);
    if (!reordered && !folded) {
        return lines;
    }
    const kept = rest.flatMap((block) => {
        const group = block.kind === "warning" ? (warnings.get(block.header) ?? []) : [];
        if (group.length < 2) {
            return block.lines;
        }
        return group[0] === block ? [foldedLine(block.header, group)] : [];
    });
    const errorLines = errors.flatMap((block) => (block.lines.at(-1) === "" ? block.lines : [...block.lines, ""]));
    const note = `(rustc output: ${[reordered ? "errors moved first" : "", folded ? "each repeated warning folded to one line with its count and places" : ""].filter(Boolean).join("; ")})`;
    return [note, ...errorLines, ...kept];
};

/** The fold as a stage of the filter: what it saved, under its own id, and skipped when the spec turns `rustc` off. */
export const rustcStage = (lines, enabled) => {
    if (!enabled.has("rustc")) {
        return { lines, stages: [] };
    }
    const folded = foldRustDiagnostics(lines);
    return { lines: folded, stages: folded === lines ? [] : [{ id: "rustc", saved: bodyBytes(lines) - bodyBytes(folded) }] };
};
