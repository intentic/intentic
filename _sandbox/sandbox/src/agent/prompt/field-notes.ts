import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FIELD_NOTES_FILE } from "@intentic/constants";

// The sandbox's own field notes: what past sessions here had to learn the hard way, ranked, and carried on the system
// append beside the owner's standing instructions. The counterpart of the project map, and the division between them is
// the whole reason this exists: the map is recomputed from the TREE every conversation, so it can only ever say what a
// scan can see. This is written from the session CORPUS by a monthly automation (automations/catalog.ts), so it carries
// what no scan can — which commands really verify here, what the box can take, how the owner asks for things.
//
// A TOON file, opened by rank rather than parsed whole: the payload is SLICED out of the source text, never re-encoded,
// so the owner's own bytes, ordering and wording survive a round trip through this module unchanged.

export const FIELD_NOTES_NOTE_TITLE = "Field notes for this sandbox";
export const FIELD_NOTES_NOTE_HEADER = `## ${FIELD_NOTES_NOTE_TITLE}`;

// Always sent, whatever the budget: `meta` says what the file is, when it was written and how far to trust it — a brief
// with no provenance is read as timeless, and this one is not.
// `priority` is deliberately NOT here. It is the index, but its columns are a title and a cost written for whoever
// opens the file, and sending all twelve rows spent 2,350 of the default 2,800 characters describing sections the turn
// was not being given. The disclosure line below does the one job the index had to do for a READER — say what is
// missing — in one line.
const ALWAYS = ["meta"] as const;

// Ranks are integers and ids are kebab-case words, so both are comma-free and quote-free by construction — which is why
// the first two columns can be read off a row without parsing the quoted prose in the rest of it. A row that does not
// look like this is not one of ours and the file is refused rather than half-read.
const ROW = /^(\d+),([a-z][a-z0-9_-]*),/;

// A top-level key opens at column 0; everything a section owns is indented under it. Both spellings TOON gives a key:
// `id:` for an object, `id[4]{cols}:` for a table.
const TOP_LEVEL = /^([a-z][a-z0-9_]*)(\[|:)/;

export interface FieldNotes {
    // The note as the model reads it, header included.
    readonly text: string;
    readonly chars: number;
    // Content hash of the WHOLE file, not of what was sent: it identifies the treatment revision, and two budgets over
    // one file are the same notes, differently truncated.
    readonly revision: string;
    readonly ranksSent: number;
    readonly ranksTotal: number;
    // Epoch ms the file was last written, for the settings row's "rewritten 3 weeks ago".
    readonly writtenAt: number;
}

interface Section {
    readonly id: string;
    readonly rank: number;
    readonly text: string;
}

// Where each top-level key's block starts and ends, in source order. Line-based rather than structural: a section's
// extent is "until the next column-0 key", which is true of every TOON document and needs no grammar.
const blocksOf = (lines: readonly string[]): Map<string, string> => {
    const opens: { key: string; at: number }[] = [];
    for (const [at, line] of lines.entries()) {
        const key = TOP_LEVEL.exec(line)?.[1];
        if (key !== undefined) {
            opens.push({ key, at });
        }
    }
    const blocks = new Map<string, string>();
    for (const [index, open] of opens.entries()) {
        blocks.set(open.key, lines.slice(open.at, opens[index + 1]?.at).join("\n").trimEnd());
    }
    return blocks;
};

// The index: the rows of the `priority` table, in the order they name themselves. Undefined when the table is missing or
// carries a row this module cannot read — a file whose index cannot be trusted is not one to truncate.
const indexOf = (block: string | undefined): readonly { readonly rank: number; readonly id: string }[] | undefined => {
    if (block === undefined) {
        return undefined;
    }
    const rows: { rank: number; id: string }[] = [];
    for (const line of block.split("\n").slice(1)) {
        const trimmed = line.trim();
        if (trimmed === "") {
            continue;
        }
        const row = ROW.exec(trimmed);
        if (row?.[1] === undefined || row[2] === undefined) {
            return undefined;
        }
        rows.push({ rank: Number(row[1]), id: row[2] });
    }
    return rows.length === 0 ? undefined : rows.toSorted((left, right) => left.rank - right.rank);
};

// Sections taken WHOLE in rank order while they fit. Never a partial section: half a rule reads as a rule, and the one
// thing worse than an unknown trap is a truncated sentence about it.
const withinBudget = (sections: readonly Section[], spent: number, budget: number): readonly Section[] => {
    const kept: Section[] = [];
    let used = spent;
    for (const section of sections) {
        const cost = section.text.length + 1;
        if (used + cost > budget) {
            break;
        }
        used += cost;
        kept.push(section);
    }
    return kept;
};

const readFieldNotesFile = (root: string): { readonly text: string; readonly writtenAt: number } | undefined => {
    const path = join(root, FIELD_NOTES_FILE);
    try {
        const text = readFileSync(path, "utf8");
        return text.trim() === "" ? undefined : { text, writtenAt: statSync(path).mtimeMs };
    } catch {
        return undefined;
    }
};

export interface FieldNotesInput {
    readonly root: string;
    readonly budget: number;
    // Said out loud rather than swallowed: a file that exists and cannot be read is a broken automation, and the only
    // place that shows is here.
    readonly onUnreadable?: (why: string) => void;
}

// Absent file ⇒ undefined and silence: that is the ordinary state before the automation has run once. A file that
// exists but cannot be indexed ⇒ undefined and a complaint, since nothing downstream can tell the two apart.
export const fieldNotes = ({ root, budget, onUnreadable }: FieldNotesInput): FieldNotes | undefined => {
    const file = readFieldNotesFile(root);
    if (file === undefined) {
        return undefined;
    }
    const lines = file.text.split("\n");
    const blocks = blocksOf(lines);
    const index = indexOf(blocks.get("priority"));
    if (index === undefined) {
        onUnreadable?.(`no readable \`priority\` table, so there is no order to send it in`);
        return undefined;
    }
    const missing = index.filter(({ id }) => !blocks.has(id)).map(({ id }) => id);
    if (missing.length > 0) {
        onUnreadable?.(`the index names sections the file does not carry: ${missing.join(", ")}`);
        return undefined;
    }
    const head = ALWAYS.flatMap((key) => {
        const block = blocks.get(key);
        return block === undefined ? [] : [block];
    });
    const ranked = index.flatMap<Section>(({ id, rank }) => {
        const text = blocks.get(id);
        return text === undefined ? [] : [{ id, rank, text }];
    });
    // The header and the disclosure line are the note's own overhead and come out of the budget, so the number in the
    // setting is what the turn actually pays.
    const spent = FIELD_NOTES_NOTE_HEADER.length + head.reduce((sum, block) => sum + block.length + 1, 0);
    const kept = withinBudget(ranked, spent, budget);
    const dropped = ranked.filter((section) => !kept.includes(section));
    // What is NOT here, named. Without it a turn cannot tell "this sandbox has no such trap" from "that section did not
    // fit", and the first reading is the dangerous one.
    const disclosure =
        dropped.length === 0
            ? `# every section of ${join(root, FIELD_NOTES_FILE)} is below.`
            : `# ranks ${kept.length + 1}-${ranked.length} of ${join(root, FIELD_NOTES_FILE)} are NOT below (${dropped
                  .map((section) => section.id)
                  .join(", ")}); read the file itself if a turn needs them.`;
    const text = [FIELD_NOTES_NOTE_HEADER, "", disclosure, ...head, ...kept.map((section) => section.text)].join("\n");
    return {
        text,
        chars: text.length,
        revision: createHash("sha256").update(file.text).digest("hex").slice(0, 8),
        ranksSent: kept.length,
        ranksTotal: ranked.length,
        writtenAt: file.writtenAt,
    };
};
