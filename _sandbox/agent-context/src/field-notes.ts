import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

// Field notes: what past sessions in one place had to learn the hard way, ranked, and carried into every new one. The
// counterpart of the project map, and the division between them is the whole reason this exists: the map is recomputed
// from the TREE every conversation, so it can only ever say what a scan can see. This is written from the session
// CORPUS (the sandbox's monthly automation, the Claude Code plugin's /intentic:field-notes; field-notes-prompt.ts is
// the brief both hand the writer), so it carries what no scan can — which commands really verify here, what the machine
// can take, how the owner asks for things. Where the file lives is the caller's business: the sandbox keeps one per
// workspace, the plugin one per project.
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
// Hyphens too, since an id is kebab-case (ROW above) and every id is also the key of its own block: a key pattern without
// them refused any file with a hyphenated id outright.
const TOP_LEVEL = /^([a-z][a-z0-9_-]*)(\[|:)/;

export interface FieldNotes {
    // The note as the model reads it, header included.
    readonly text: string;
    readonly chars: number;
    // Content hash of everything the file can send (`meta` and every ranked section, in rank order), not of what this
    // budget sent: two budgets over one file are the same notes, differently truncated. Not of the whole file either: a
    // block outside the index reaches no turn, and hashing it restarted the comparison over an edit nobody received
    // (2026-10-12, a `debugging` block added without a rank).
    readonly revision: string;
    // Top-level blocks the index does not rank, so no budget ever sends them; named so the settings row can say so.
    readonly unlisted: readonly string[];
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

const readFieldNotesFile = (file: string): { readonly text: string; readonly writtenAt: number } | undefined => {
    try {
        const text = readFileSync(file, "utf8");
        return text.trim() === "" ? undefined : { text, writtenAt: statSync(file).mtimeMs };
    } catch {
        return undefined;
    }
};

export interface FieldNotesInput {
    // The notes file itself; its path is also what the brief names when it tells a turn where the rest is.
    readonly file: string;
    // The brief's heading, naming the place the notes are about; the sandbox's own by default.
    readonly title?: string;
    readonly budget: number;
    // Said out loud rather than swallowed: a file that exists and cannot be read is a broken automation, and the only
    // place that shows is here.
    readonly onUnreadable?: (why: string) => void;
}

// What is NOT in the note, named. Without it a turn cannot tell "this sandbox has no such trap" from "that section did not
// fit", and the first reading is the dangerous one. An unranked block is named too, or "every section is below" would be
// false about it; the line for a file with neither is the one every brief has always carried, byte for byte.
const disclosureOf = (path: string, sent: number, dropped: readonly Section[], unlisted: readonly string[]): string => {
    const unranked =
        unlisted.length === 0 ? "" : `${unlisted.join(", ")} ${unlisted.length === 1 ? "has no rank and is" : "have no rank and are"} not sent either; `;
    if (dropped.length === 0) {
        return unlisted.length === 0
            ? `# every section of ${path} is below.`
            : `# every ranked section of ${path} is below; ${unranked}read the file itself if a turn needs ${unlisted.length === 1 ? "it" : "them"}.`;
    }
    return `# ranks ${sent + 1}-${sent + dropped.length} of ${path} are NOT below (${dropped
        .map((section) => section.id)
        .join(", ")}); ${unranked}read the file itself if a turn needs them.`;
};

// Absent file ⇒ undefined and silence: that is the ordinary state before the automation has run once. A file that
// exists but cannot be indexed ⇒ undefined and a complaint, since nothing downstream can tell the two apart.
export const fieldNotes = ({ file: path, budget, onUnreadable, title = FIELD_NOTES_NOTE_TITLE }: FieldNotesInput): FieldNotes | undefined => {
    const file = readFieldNotesFile(path);
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
    const listed = new Set<string>([...ALWAYS, "priority", ...index.map(({ id }) => id)]);
    const unlisted = [...blocks.keys()].filter((key) => !listed.has(key));
    // The header and the disclosure line are the note's own overhead and come out of the budget, so the number in the
    // setting is what the turn actually pays.
    const header = `## ${title}`;
    const spent = header.length + head.reduce((sum, block) => sum + block.length + 1, 0);
    const kept = withinBudget(ranked, spent, budget);
    const dropped = ranked.filter((section) => !kept.includes(section));
    const disclosure = disclosureOf(path, kept.length, dropped, unlisted);
    const text = [header, "", disclosure, ...head, ...kept.map((section) => section.text)].join("\n");
    return {
        text,
        chars: text.length,
        revision: createHash("sha256")
            .update([...head, ...ranked.map((section) => section.text)].join("\n"))
            .digest("hex")
            .slice(0, 8),
        unlisted,
        ranksSent: kept.length,
        ranksTotal: ranked.length,
        writtenAt: file.writtenAt,
    };
};
