import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// What the one palette can take you to, and how a typed query picks among all of it at once: agents, files, terminals
// and commands in a single list, kinds ordered against each other rather than split across shortcuts. The first
// character of the query is the scope, so narrowing is something typed rather than a second chord to remember, and the
// chips above the results are that same state made visible.

export type JumpKind = "agent" | "file" | "terminal" | "command";

// Fixed precedence: where the work is, then what is being read, then what is running, then what can be done. It orders
// the unqueried palette and breaks every tie in the queried one.
export const JUMP_KINDS: readonly JumpKind[] = [`agent`, `file`, `terminal`, `command`];

// `@` is a file here as it is in the composer, where `@path` attaches one; `#` is a conversation, `$` is a shell
// prompt, and `>` is the command prefix this palette already had.
const PREFIX: Readonly<Record<JumpKind, string>> = { agent: `#`, file: `@`, terminal: `$`, command: `>` };

const ICON: Readonly<Record<JumpKind, IconName>> = { agent: `robot`, file: `file-tree`, terminal: `code`, command: `chevron-right` };

export interface JumpScope {
    // undefined is the unscoped palette: every kind at once.
    readonly kind: JumpKind | undefined;
    // Typed at the head of the query to narrow to this kind; empty for the unscoped chip.
    readonly prefix: string;
    readonly label: string;
    readonly icon: IconName;
}

const scopeLabel = (kind: JumpKind): string => {
    switch (kind) {
        case `agent`:
            return t(`shell.quickOpen.agents`);
        case `file`:
            return t(`shell.quickOpen.files`);
        case `terminal`:
            return t(`shell.quickOpen.terminals`);
        default:
            return t(`shell.quickOpen.commands`);
    }
};

/** The chips, which are the only place the prefixes are taught: recognition rather than a keystroke to recall. */
export const jumpScopes = (): readonly JumpScope[] => [
    { kind: undefined, prefix: ``, label: t(`shell.quickOpen.everything`), icon: `search` },
    ...JUMP_KINDS.map((kind) => ({ kind, prefix: PREFIX[kind], label: scopeLabel(kind), icon: ICON[kind] })),
];

export interface JumpQuery {
    // Which kind the query narrows to, or undefined for all of them.
    readonly kind: JumpKind | undefined;
    // The query with its scope prefix taken off, trimmed: what every ranker matches on.
    readonly text: string;
}

/** Reads the scope off the head of the query. The prefix stays in the field, so Backspace is how a scope is left. */
export const parseJumpQuery = (raw: string): JumpQuery => {
    const trimmed = raw.trimStart();
    const kind = JUMP_KINDS.find((candidate) => PREFIX[candidate] === trimmed.charAt(0));
    return kind === undefined ? { kind: undefined, text: raw.trim() } : { kind, text: trimmed.slice(1).trim() };
};

/** The query, written so it narrows to `kind`: what a chip press puts in the field. */
export const scopedQuery = (kind: JumpKind | undefined, text: string): string => (kind === undefined ? text : `${PREFIX[kind]}${text}`);

export interface ScoredRow {
    readonly kind: JumpKind;
    // 0..1, the one axis both rankers answer on (commandSearch.nameScore, fuzzyPaths.fuzzyScore); 0 for a row listed
    // without a query, which leaves JUMP_KINDS to order the palette.
    readonly score: number;
}

export interface JumpGroup<Row extends ScoredRow> {
    readonly kind: JumpKind;
    readonly rows: readonly Row[];
}

/** How many rows of one kind the unscoped palette shows, so no kind can flood the list a bare query opens on. */
export const UNSCOPED_CAP = 5;

// A row earns its place by being at least half as good as the best answer on the list. Kinds are listed in blocks, so
// without this one kind's near-misses — a path that merely holds the query's letters in order — sit above another
// kind's strong row on the strength of a sibling they were ranked beside.
const RELEVANCE = 0.5;

const best = (group: JumpGroup<ScoredRow>): number => Math.max(...group.rows.map((row) => row.score));

/**
 * The palette's list: rows kept in the order their own kind ranked them, capped per kind, kinds ordered by their best
 * row. The row under Enter is then whichever kind holds the best evidence for what was typed, rather than a fixed
 * favourite — and with nothing typed every score is 0, which leaves JUMP_KINDS' order standing.
 */
export const groupJumpRows = <Row extends ScoredRow>(rows: readonly Row[], cap: number): readonly JumpGroup<Row>[] => {
    // Zero in the spread keeps an empty list (and the unqueried palette, where every score is 0) at a floor of 0.
    const floor = Math.max(0, ...rows.map((row) => row.score)) * RELEVANCE;
    return JUMP_KINDS.flatMap((kind) => {
        const mine = rows.filter((row) => row.kind === kind && row.score >= floor).slice(0, cap);
        return mine.length === 0 ? [] : [{ kind, rows: mine }];
    })
        // Stable, so kinds whose best row scores the same keep the precedence above.
        .toSorted((left, right) => best(right) - best(left));
};
