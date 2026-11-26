import { sandboxNoticeOf } from "@intentic/sandbox-contract/events/sandbox-notice";
import { noticeFailure } from "./sandboxNotice";
import type { ChatMessage, ChatTurn } from "./transcript";

/* WHERE A NOTICE IS DRAWN, by what it asks of the reader (2026-11-25; the owner's pick of "Live, then receipt").

   - What ARRIVED for the agent (another agent's report or message, a watch that fired) is a card signed by its sender,
     drawn where it arrived; reports that arrive back to back share one card.
   - What the sandbox told the agent about one of its subagents between start and report (it moved, stays stopped, a
     message did not go) is a line on the owner's own edge, since it went to the agent the way a prompt does, but never
     the owner's bubble (2026-11-26); news that arrives back to back is one block (NoticeNews.vue).
   - A failure the turn ended on, with nothing run after it, is a tinted strip with its fix.
   - A wait still running (a renewal, a route, an armed watch), and a row whose one press still matters in the latest
     turn, stays a line of its own.
   - Everything else is what happened to the turn's machinery: it is not drawn in the column but counted on the turn's
     receipt, one quiet line at the turn's foot that opens into the list.

   Needs, background jobs, memory holds and a fresh start keep their own components, and this leaves them alone. */

/** How a notice row that stays in the column is drawn. */
export type NoticeTier = `arrival` | `news` | `strip` | `inline`;

/** What a turn's receipt holds: its notices, oldest first, and what its one line says about them. */
export interface TurnReceipt {
    readonly rows: readonly ChatMessage[];
    // Failures among them: refusals something got past, retries that came through.
    readonly problems: number;
    // A runtime's own warnings and errors among them.
    readonly warnings: number;
    // The latest row saying where the turn's work went (landed, held, refused, into the parent).
    readonly land: ChatMessage | undefined;
    // How long its runs took, summed from the bubble each ended in.
    readonly durationMs: number | undefined;
    // A person stopped it.
    readonly stopped: boolean;
}

/** Reports, or news about subagents, that arrived back to back: drawn as one at the first. */
export interface ArrivalGroup {
    readonly rows: readonly ChatMessage[];
}

export interface NoticeLayout {
    // How each notice row still drawn in the column is drawn, by its id.
    readonly tiers: ReadonlyMap<number, NoticeTier>;
    // The rows not drawn where they stand: on a receipt, or in a group drawn at an earlier row.
    readonly folded: ReadonlySet<number>;
    // Each turn's receipt, by the turn's id; a turn whose notices all stay in the column has none.
    readonly receipts: ReadonlyMap<number, TurnReceipt>;
    // Each group of reports, by the id of the row it is drawn at.
    readonly groups: ReadonlyMap<number, ArrivalGroup>;
}

/** What the layout reads beside the turns. */
export interface NoticeLayoutContext {
    // Rows an incident folds into a later row (chatIncidents.ts): already not drawn, and not counted again here.
    readonly incidentFolded: ReadonlySet<number>;
    // The turn still being written, if any: it ends on nothing yet, so no failure in it stands as its ending.
    readonly liveTurn: number | undefined;
    // Whether a row's wait is still running: an armed watch, a renewal, a route being found.
    readonly pending: (row: ChatMessage) => boolean;
}

// The follow-ups a row offers by name (TranscriptRow.noticeAction) that keep it in the column while they can matter: in
// the conversation's latest turn. A memory hold draws a component of its own.
const PRESSES: ReadonlySet<ChatMessage[`noticeAction`]> = new Set([`depsInstall`, `watchStop`, `sendAgain`, `switchModel`]);

// Where the work went (sandbox-notice.ts): what a receipt names on its line.
const LAND_CODES: ReadonlySet<string> = new Set([`landed`, `landHeld`, `landConflict`, `intoParent`, `intoParentClash`]);

/** A row another component draws whole, which this layout leaves where it stands. */
const drawnElsewhere = (row: ChatMessage): boolean =>
    row.need !== undefined ||
    row.backgroundJob !== undefined ||
    row.noticeAction === `sendAnyway` ||
    row.noticeAction === `sandboxMemory` ||
    row.noticeCode?.code === `freshStart` ||
    row.text === ``;

/** Something that arrived for the agent from outside the turn: another agent's words, or a watch that fired. An answered
 *  need is not one: its own card, where it was asked, already says how it ended. */
export const isArrival = (row: ChatMessage): boolean => row.role === `notice` && (row.agentWords !== undefined || row.watchWake !== undefined);

/** What the sandbox told the agent about one of its subagents (child-news.ts). */
export const isNews = (row: ChatMessage): boolean => row.role === `notice` && row.childNews !== undefined;

/** A report from a subagent (or a review or test pass) this conversation started. */
const isReport = (row: ChatMessage): boolean => row.role === `notice` && row.agentWords?.kind === `child`;

// Which rows share a block when they arrive back to back: reports with reports, news with news.
const familyOf = (row: ChatMessage): `report` | `news` | undefined => (isReport(row) ? `report` : isNews(row) ? `news` : undefined);

/** A row this layout places: a notice no other component draws whole. */
const placed = (row: ChatMessage, context: NoticeLayoutContext): boolean =>
    row.role === `notice` && !drawnElsewhere(row) && !context.incidentFolded.has(row.id);

// The row a turn ended on, quiet notices and folded rows stepped over: a failure stands as the ending only if it is this.
const lastWord = (rows: readonly ChatMessage[], context: NoticeLayoutContext): ChatMessage | undefined =>
    rows.findLast((row) => {
        if (context.incidentFolded.has(row.id) || (row.role === `notice` && row.text === `` && row.need === undefined && row.backgroundJob === undefined)) {
            return false;
        }
        return (
            row.role !== `notice` || !placed(row, context) || isArrival(row) || isNews(row) || noticeFailure(row) !== undefined || row.noticeAction !== undefined
        );
    });

const tierOf = (row: ChatMessage, context: NoticeLayoutContext, ending: ChatMessage | undefined, latest: boolean, live: boolean): NoticeTier | undefined => {
    if (isArrival(row)) {
        return `arrival`;
    }
    if (isNews(row)) {
        return `news`;
    }
    if (context.pending(row)) {
        return `inline`;
    }
    if (!live && row === ending && noticeFailure(row)?.ends === true) {
        return `strip`;
    }
    return latest && PRESSES.has(row.noticeAction) ? `inline` : undefined;
};

const receiptOf = (turn: ChatTurn, rows: readonly ChatMessage[]): TurnReceipt => {
    const durations = turn.messages.flatMap((row) => (row.role === `assistant` && row.usage?.durationMs !== undefined ? [row.usage.durationMs] : []));
    const land = rows.findLast((row) => LAND_CODES.has(row.noticeCode?.code ?? ``));
    return {
        rows,
        problems: rows.filter((row) => noticeFailure(row) !== undefined).length,
        warnings: rows.filter((row) => row.agentNotice !== undefined && row.agentNotice.level !== `info`).length,
        land,
        durationMs: durations.length === 0 ? undefined : durations.reduce((sum, ms) => sum + ms, 0),
        stopped: rows.some((row) => sandboxNoticeOf(row)?.code === `stopped`),
    };
};

// Reports that arrive with nothing drawn between them share a card: a fleet reporting while the agent was busy. News
// about subagents does the same among itself: one cause stopping four subagents is one block, not four.
const groupsOf = (rows: readonly ChatMessage[], drawn: (row: ChatMessage) => boolean): ArrivalGroup[] => {
    const groups: ChatMessage[][] = [];
    let open: { readonly family: `report` | `news`; readonly rows: ChatMessage[] } | undefined;
    for (const row of rows) {
        const family = familyOf(row);
        if (family !== undefined) {
            if (open?.family === family) {
                open.rows.push(row);
            } else {
                open = { family, rows: [row] };
                groups.push(open.rows);
            }
        } else if (drawn(row)) {
            open = undefined;
        }
    }
    return groups.filter((group) => group.length > 1).map((group) => ({ rows: group }));
};

interface TurnLayout {
    readonly tiers: ReadonlyMap<number, NoticeTier>;
    readonly folded: readonly number[];
    readonly receipt: TurnReceipt | undefined;
    readonly groups: readonly ArrivalGroup[];
}

const turnLayout = (turn: ChatTurn, context: NoticeLayoutContext, latest: boolean): TurnLayout => {
    const live = context.liveTurn === turn.id;
    const ending = lastWord(turn.messages, context);
    const tiers = new Map<number, NoticeTier>();
    const onReceipt: ChatMessage[] = [];
    for (const row of turn.messages) {
        if (!placed(row, context)) {
            continue;
        }
        const tier = tierOf(row, context, ending, latest, live);
        if (tier === undefined) {
            onReceipt.push(row);
        } else {
            tiers.set(row.id, tier);
        }
    }
    const folded = new Set(onReceipt.map((row) => row.id));
    const groups = groupsOf(turn.messages, (row) => !folded.has(row.id) && !context.incidentFolded.has(row.id) && !(row.role === `notice` && row.text === ``));
    for (const group of groups) {
        for (const row of group.rows.slice(1)) {
            folded.add(row.id);
        }
    }
    return { tiers, folded: [...folded], receipt: onReceipt.length === 0 ? undefined : receiptOf(turn, onReceipt), groups };
};

const sameRows = (left: readonly ChatMessage[], right: readonly ChatMessage[]): boolean =>
    left.length === right.length && left.every((row, index) => row === right[index]);

const sameReceipt = (left: TurnReceipt | undefined, right: TurnReceipt): left is TurnReceipt =>
    left !== undefined &&
    sameRows(left.rows, right.rows) &&
    left.problems === right.problems &&
    left.warnings === right.warnings &&
    left.land === right.land &&
    left.durationMs === right.durationMs &&
    left.stopped === right.stopped;

const EMPTY: NoticeLayout = { tiers: new Map(), folded: new Set(), receipts: new Map(), groups: new Map() };

/**
 * Where each notice of `turns` is drawn. `previous` is the last answer for the same transcript, asked again on every
 * frame of a streamed turn: a receipt or group that did not change comes back as the same object, so the rows keyed on
 * them are not drawn again.
 */
export const noticeLayoutOf = (turns: readonly ChatTurn[], context: NoticeLayoutContext, previous: NoticeLayout = EMPTY): NoticeLayout => {
    const tiers = new Map<number, NoticeTier>();
    const folded = new Set<number>();
    const receipts = new Map<number, TurnReceipt>();
    const groups = new Map<number, ArrivalGroup>();
    turns.forEach((turn, index) => {
        const layout = turnLayout(turn, context, index === turns.length - 1);
        for (const [id, tier] of layout.tiers) {
            tiers.set(id, tier);
        }
        for (const id of layout.folded) {
            folded.add(id);
        }
        if (layout.receipt !== undefined) {
            const was = previous.receipts.get(turn.id);
            receipts.set(turn.id, sameReceipt(was, layout.receipt) ? was : layout.receipt);
        }
        for (const group of layout.groups) {
            const head = group.rows[0]!.id;
            const was = previous.groups.get(head);
            groups.set(head, was !== undefined && sameRows(was.rows, group.rows) ? was : group);
        }
    });
    if (tiers.size === 0 && folded.size === 0 && receipts.size === 0 && groups.size === 0) {
        return previous.tiers.size === 0 && previous.receipts.size === 0 && previous.groups.size === 0 && previous.folded.size === 0 ? previous : EMPTY;
    }
    return { tiers, folded, receipts, groups };
};
