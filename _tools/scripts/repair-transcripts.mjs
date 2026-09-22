#!/usr/bin/env node
// Takes turns that never ran out of the conversation records already written to the history volume; the daemon stops
// writing them at transcript-fold.ts `retract`. One-shot and hand-run, per docs/design/turns-that-never-ran.md.
//
//   node repair-transcripts.mjs [dir]           # report what would change, touch nothing
//   node repair-transcripts.mjs [dir] --apply   # rewrite the records and their checkpoints

import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";

// The clause errorRow appends to an attended refusal that ran nothing; the only form whose message can repeat.
const HELD_FOR_RESEND = "Your message was not delivered: it is held for you to send again.";

const parse = (line) => {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
};

// Adjacent rows of one run, in file order; a row predating the run stamp is its own span, judged by its neighbour.
const spansOf = (rows) => {
    const spans = [];
    for (const [index, row] of rows.entries()) {
        const last = spans.at(-1);
        const run = row?.run;
        if (last !== undefined && run !== undefined && last.run === run) {
            last.end = index;
            continue;
        }
        spans.push({ run, start: index, end: index });
    }
    return spans;
};

const held = (row) => row?.role === "notice" && typeof row.text === "string" && row.text.includes(HELD_FOR_RESEND);

// Which rows this file loses: a stamped span whole, an unstamped refusal only the user row directly above it.
const voidRows = (rows) => {
    const doomed = new Set();
    for (const { run, start, end } of spansOf(rows)) {
        const span = rows.slice(start, end + 1);
        if (run === undefined) {
            if (held(span[0]) && rows[start - 1]?.role === "user" && rows[start - 1]?.run === undefined) {
                doomed.add(start - 1).add(start);
            }
            continue;
        }
        const ranNothing = !span.some((row) => row?.role === "assistant");
        if (!ranNothing || !span.some((row) => row?.role === "user") || !held(span.at(-1))) {
            continue;
        }
        for (let index = start; index <= end; index += 1) {
            doomed.add(index);
        }
    }
    return doomed;
};

// Old index → new index for the rows that survive; a deleted row maps to nothing.
const renumbering = (total, doomed) => {
    const moved = new Map();
    let next = 0;
    for (let index = 0; index < total; index += 1) {
        if (doomed.has(index)) {
            continue;
        }
        moved.set(index, next);
        next += 1;
    }
    return moved;
};

const repairCheckpoints = (file, shifts) => {
    let changed = 0;
    const next = { ...file };
    for (const [conversationId, moved] of shifts) {
        const existing = next[conversationId];
        if (existing === undefined) {
            continue;
        }
        const kept = {};
        for (const [index, checkpoint] of Object.entries(existing)) {
            const to = moved.get(Number(index));
            if (to === undefined) {
                changed += 1;
                continue;
            }
            if (to !== Number(index)) {
                changed += 1;
            }
            kept[String(to)] = checkpoint;
        }
        next[conversationId] = kept;
    }
    return { file: next, changed };
};

const main = async () => {
    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const dir = args.find((arg) => !arg.startsWith("--")) ?? join(HISTORY_ROOT, "transcripts");
    const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
    if (names.length === 0) {
        console.log(`no records in ${dir}`);
        return;
    }
    const shifts = new Map();
    let repaired = 0;
    let dropped = 0;
    let emptied = 0;
    for (const name of names) {
        const path = join(dir, name);
        const raw = await readFile(path, "utf8").catch(() => "");
        const lines = raw.split("\n").filter((line) => line.length > 0);
        const rows = lines.map(parse);
        const doomed = voidRows(rows);
        if (doomed.size === 0) {
            continue;
        }
        repaired += 1;
        dropped += doomed.size;
        const conversationId = name.slice(0, -".jsonl".length);
        shifts.set(conversationId, renumbering(lines.length, doomed));
        const kept = lines.filter((_line, index) => !doomed.has(index));
        console.log(`${name}: ${doomed.size} row(s) of ${lines.length}${kept.length === 0 ? " (record emptied)" : ""}`);
        if (!apply) {
            continue;
        }
        if (kept.length === 0) {
            // Removed, not emptied: `fork` treats the file existing as a branch already opened and would copy nothing.
            emptied += 1;
            await rm(path);
            continue;
        }
        // Temp file and rename, as the record's own truncate writes, so a concurrent reader never sees half a file.
        const temp = `${path}.${process.pid}.tmp`;
        await writeFile(temp, kept.map((line) => `${line}\n`).join(""));
        await rename(temp, path);
    }
    const checkpointsPath = join(dirname(dir), "turn-checkpoints.json");
    const current = parse(await readFile(checkpointsPath, "utf8").catch(() => "")) ?? {};
    const { file, changed } = repairCheckpoints(current, shifts);
    if (apply && changed > 0) {
        const temp = `${checkpointsPath}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(file));
        await rename(temp, checkpointsPath);
    }
    console.log(
        `${apply ? "repaired" : "would repair"} ${repaired} record(s): ${dropped} row(s), ${emptied} emptied, ${changed} checkpoint(s) moved or dropped`,
    );
    if (!apply) {
        console.log("nothing was written — pass --apply to rewrite");
    }
};

await main();
