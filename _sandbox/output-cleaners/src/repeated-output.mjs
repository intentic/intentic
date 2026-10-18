// Repeated-line and wide-token filters, preserving diagnostic lines.
import { IMPORTANT } from "./cleaner-shapes.mjs";

// Collapses a run of 3+ identical consecutive lines to one line plus a count marker. Lossless on distinct content, so
// it's safe on both success output and repeated failure traces.
export const dedupeRuns = (lines) => {
    const out = [];
    for (let i = 0; i < lines.length;) {
        let j = i + 1;
        while (j < lines.length && lines[j] === lines[i]) {
            j++;
        }
        const run = j - i;
        out.push(lines[i]);
        if (run >= 3 && !IMPORTANT.test(lines[i])) {
            out.push(`  … (${run - 1} more identical lines)`);
        } else {
            for (let k = 1; k < run; k++) {
                out.push(lines[i]);
            }
        }
        i = j;
    }
    return out;
};

// An unbroken run of non-space characters this long is machine-generated: minified JSON, a base64 blob, a bundled-JS
// line, a binary `strings` dump. Prose and code break for a space every few characters, so the RUN is the unit here and
// not the line: a 2000-character README bullet or a wrapped error message keeps every word, while the blob beside it on
// the same line is cut. A line-length threshold cannot make that distinction at any setting.
const WIDE_RUN = 400;
const WIDE_HEAD = 240;
const WIDE_TAIL = 80;
// Head-heavy: a blob's first characters say what it is (the JSON keys, the `data:` prefix), its last say where it ends.
const elideRun = (run) => `${run.slice(0, WIDE_HEAD)}… ${run.length - WIDE_HEAD - WIDE_TAIL} chars elided …${run.slice(-WIDE_TAIL)}`;
const WIDE_PATTERN = new RegExp(String.raw`\S{${WIDE_RUN + 1},}`, "g");
export const elideWideRuns = (lines) =>
    lines.map((line) => (line.length > WIDE_RUN && !IMPORTANT.test(line) ? line.replaceAll(WIDE_PATTERN, elideRun) : line));
