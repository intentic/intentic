// Line and byte budgets, with bounded priority retention for diagnostics.
import { bodyBytes, IMPORTANT } from "./cleaner-shapes.mjs";

// Generic success cap: outputs past MAX keep the first HEAD and last TAIL lines. Failures keep everything up to
// FAIL_TAIL, since errors live at the end.
const HEAD = 30;
const TAIL = 50;
export const MAX = 100;
export const FAIL_TAIL = 500;

// A line is not a unit of size: some commands return few lines of very long ones. These byte budgets are generous
// enough that ordinary output never meets them, firing only on the long-line shapes the line cap can't see.
export const LOG_MAX_BYTES = 16_000;
export const READ_MAX_BYTES = 96_000;
// Head/tail split of a byte budget mirrors the line cap's 30/50 bias toward the end, where a log's signal is.
const BYTE_HEAD_SHARE = 0.375;

// A deliberate read (`cat`, `sed -n`, `awk`, `git diff/show` on a path) is not a log's noise-at-both-ends shape, so it
// gets the Read tool's own line ceiling instead of the log cap, trimmed from the end where a read naturally stops.
const READ_MAX = 2000;
// Narrow on the right: `git log` without `-p` is history, `git log -p` is a read. Permissive on the left: the
// lookbehind only excludes being the tail of a path or identifier, accepting a quote, `--`, or statement start alike.

// Git's global options before the verb, in two shapes: a flag glued to its value (`--no-pager`) is one token, but
// several take the value as a separate word. The list is explicit rather than "any flag takes a value", which could
// swallow the verb itself.
const GIT_OPTIONS = String.raw`(?:(?:-[Cc]|--(?:git-dir|work-tree|namespace|exec-path|super-prefix))\s+\S+\s+|-\S+\s+)*`;
export const READ_COMMAND = new RegExp(
    String.raw`(?<![\w.-])(?:cat|bat|sed\s+-n|awk|git\s+${GIT_OPTIONS}(?:diff|show)\b|git\s+${GIT_OPTIONS}log\s+(?:[^;&|]*\s)?-p)\b`,
);

// Takes whole lines until `budget` bytes are spent; a partial line would misrepresent the output it came from.
const takeWithinBudget = (source, budget) => {
    const kept = [];
    let spent = 0;
    for (const line of source) {
        spent += line.length + 1;
        if (spent > budget) {
            break;
        }
        kept.push(line);
    }
    return kept;
};

export const byteBudget = (command) => (READ_COMMAND.test(command) ? READ_MAX_BYTES : LOG_MAX_BYTES);

// The budgets a command earned, or the ones a caller with no command names (an MCP tool's text: guard/mcp-output.ts).
const budgetsOf = (command, limits) => {
    const isRead = READ_COMMAND.test(command);
    return {
        isRead,
        maxLines: limits?.lines ?? (isRead ? READ_MAX : MAX),
        maxBytes: limits?.chars ?? byteBudget(command),
        head: limits?.head ?? HEAD,
        tail: limits?.tail ?? TAIL,
    };
};

// Caps on lines OR bytes, whichever policy the command earned. Returns the same array unchanged when nothing is over
// budget, so the caller can tell "did not fire" from "fired and removed nothing".
const plainCapOutput = (lines, command, limits) => {
    const { isRead, maxLines, maxBytes, head: headLines, tail: tailLines } = budgetsOf(command, limits);
    // Lines first: it is the cheaper test and the one whose elision marker reads best.
    if (lines.length > maxLines) {
        return isRead
            ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines elided: narrow the range or use the Read tool …`]
            : [...lines.slice(0, headLines), `… ${lines.length - headLines - tailLines} lines elided …`, ...lines.slice(-tailLines)];
    }
    if (bodyBytes(lines) <= maxBytes) {
        return lines;
    }
    // Over on bytes within the line limit means long lines: take from the end for a read, both ends for a log.
    if (isRead) {
        const head = takeWithinBudget(lines, maxBytes);
        return [...head, `… ${lines.length - head.length} more lines elided (${bodyBytes(lines)} bytes): narrow the range or use the Read tool …`];
    }
    const head = takeWithinBudget(lines, Math.round(maxBytes * BYTE_HEAD_SHARE));
    const tail = takeWithinBudget(lines.toReversed(), maxBytes - bodyBytes(head)).toReversed();
    // A single line longer than the whole budget leaves both ends empty; keep its head rather than only a marker.
    if (head.length === 0 && tail.length === 0) {
        return [`${lines[0].slice(0, maxBytes)}… line truncated at ${maxBytes} bytes …`];
    }
    return [...head, `… ${lines.length - head.length - tail.length} lines elided (${bodyBytes(lines)} bytes) …`, ...tail];
};

// Retain priority lines from the cut middle before ordinary head/tail detail. One neighbouring line on either side
// fits only after the priority lines themselves; saturation is explicitly bounded by the same line and byte caps.
export const priorityCap = (lines, maxLines, maxBytes, fallback, head = HEAD) => {
    const remaining = new Map();
    for (const line of fallback) {
        remaining.set(line, (remaining.get(line) ?? 0) + 1);
    }
    if (
        !lines.some((line) => {
            if (!IMPORTANT.test(line)) {
                return false;
            }
            const count = remaining.get(line) ?? 0;
            remaining.set(line, count - 1);
            return count <= 0;
        })
    ) {
        return fallback;
    }
    const selected = new Set();
    let spent = 100;
    const add = (index) => {
        if (
            index < 0 ||
            index >= lines.length ||
            selected.has(index) ||
            selected.size >= maxLines - 1 ||
            spent + lines[index].length + 1 > maxBytes
        ) {
            return;
        }
        selected.add(index);
        spent += lines[index].length + 1;
    };
    const priority = lines.flatMap((line, index) => (IMPORTANT.test(line) ? [index] : []));
    priority.forEach(add);
    for (const index of priority) {
        add(index - 1);
        add(index + 1);
    }
    for (let index = 0; index < Math.max(head, lines.length); index++) {
        if (index < head) {
            add(index);
        }
        add(lines.length - index - 1);
    }
    return [...[...selected].sort((a, b) => a - b).map((index) => lines[index]), `… ${lines.length - selected.size} lines elided …`];
};

export const capOutput = (lines, command, limits) => {
    let capped = plainCapOutput(lines, command, limits);
    if (capped === lines) {
        return lines;
    }
    const { isRead, maxLines, maxBytes, head: headLines } = budgetsOf(command, limits);
    // The line cap can still leave oversized lines behind. Enforce both budgets, reserving room for the marker.
    if (bodyBytes(capped) > maxBytes) {
        const budget = maxBytes - 100;
        const head = takeWithinBudget(capped, isRead ? budget : Math.round(budget * BYTE_HEAD_SHARE));
        const tail = isRead ? [] : takeWithinBudget(capped.toReversed(), budget - bodyBytes(head)).toReversed();
        capped =
            head.length === 0 && tail.length === 0
                ? [`${capped[0].slice(0, budget)}… line truncated at ${budget} bytes …`]
                : [...head, `… output elided (${bodyBytes(lines)} bytes) …`, ...tail];
    }
    return priorityCap(lines, maxLines, maxBytes, capped, headLines);
};
