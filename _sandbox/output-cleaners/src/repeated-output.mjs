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

// What `\s` matches, by UTF-16 code unit: ECMAScript's white space and line terminators.
const isSpace = (code) =>
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0xa0 &&
        (code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff));

// Every run of more than WIDE_RUN non-space characters cut down by elideRun: `\S{401,}` replaced, by a scan. The pattern
// threw "Maximum call stack size exceeded" under node on a run of about six million (2026-11-24): a sourcemap, a
// `base64 -w0`, a minified API answer, after which the whole filter answered with the raw text, every byte of it.
const elideWide = (line) => {
    let out = "";
    let copied = 0;
    let runStart = -1;
    for (let at = 0; at <= line.length; at += 1) {
        if (at < line.length && !isSpace(line.charCodeAt(at))) {
            runStart = runStart === -1 ? at : runStart;
            continue;
        }
        if (runStart !== -1 && at - runStart > WIDE_RUN) {
            out += line.slice(copied, runStart) + elideRun(line.slice(runStart, at));
            copied = at;
        }
        runStart = -1;
    }
    return copied === 0 ? line : out + line.slice(copied);
};

export const elideWideRuns = (lines) => lines.map((line) => (line.length > WIDE_RUN && !IMPORTANT.test(line) ? elideWide(line) : line));
