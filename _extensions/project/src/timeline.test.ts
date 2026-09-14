import type { AgentSummary, Snapshot } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { byDay, dayOf, firstLine, timelineRows } from "./timeline.js";

const NOON = Date.UTC(2026, 8, 14, 12, 0, 0);

const snapshot = (over: Partial<Snapshot> & Pick<Snapshot, "id" | "trigger">): Snapshot => ({ at: NOON, ...over });

// Only the fields the timeline reads; the rest of a summary is the board's business.
const agent = (over: Partial<AgentSummary> & Pick<AgentSummary, "id">): AgentSummary =>
    ({ status: `landed`, updatedAt: NOON, unread: false, ...over }) as AgentSummary;

describe(`the timeline`, () => {
    it(`is the tree's own restore points, newest first as given, with the hidden captures left out`, () => {
        const rows = timelineRows(
            [snapshot({ id: `b`, trigger: `user`, at: NOON }), snapshot({ id: `i`, trigger: `interval`, at: NOON - 1 }), snapshot({ id: `a`, trigger: `turn`, at: NOON - 2, label: `Add a pricing section` })],
            [],
        );
        expect(rows.map((row) => row.id)).toEqual([`b`, `a`]);
        expect(rows[0]).toMatchObject({ kind: `you`, title: `Your edits` });
        expect(rows[1]).toMatchObject({ kind: `assistant`, title: `Add a pricing section` });
    });

    it(`folds a landing's drafted sentence onto the point it made, and spends each landing once`, () => {
        const rows = timelineRows(
            [snapshot({ id: `second`, trigger: `turn`, at: NOON, label: `Tidy the footer` }), snapshot({ id: `first`, trigger: `turn`, at: NOON - 10_000, label: `Add pricing` })],
            [agent({ id: `c1`, updatedAt: NOON - 9_000, landedMessage: { subject: `Add a pricing section with three tiers` } })],
        );
        expect(rows[1]).toMatchObject({ id: `first`, subject: `Add a pricing section with three tiers`, agentId: `c1` });
        expect(rows[0]?.subject).toBeUndefined();
    });

    it(`ignores a landing whose record sits far from any point, rather than pinning it on the wrong one`, () => {
        const rows = timelineRows(
            [snapshot({ id: `t`, trigger: `turn`, at: NOON, label: `Add pricing` })],
            [agent({ id: `old`, updatedAt: NOON - 60 * 60_000, landedMessage: { subject: `Something from an hour ago` } })],
        );
        expect(rows[0]?.subject).toBeUndefined();
    });

    it(`titles a point by its prompt's first line, cut when a paragraph was pasted`, () => {
        expect(firstLine(`\n  Make the header blue\nand the footer too`)).toBe(`Make the header blue`);
        expect(firstLine(`x`.repeat(200))).toHaveLength(120);
        expect(firstLine(`x`.repeat(200)).endsWith(`…`)).toBe(true);
    });

    it(`groups rows under Today, Yesterday, then the date`, () => {
        const rows = timelineRows(
            [
                snapshot({ id: `now`, trigger: `user`, at: NOON }),
                snapshot({ id: `yday`, trigger: `user`, at: NOON - 86_400_000 }),
                snapshot({ id: `old`, trigger: `user`, at: NOON - 10 * 86_400_000 }),
            ],
            [],
        );
        const days = byDay(rows, NOON, `en-GB`);
        expect(days.map((day) => day.day)).toEqual([`Today`, `Yesterday`, `4 September`]);
        expect(days[0]?.rows.map((row) => row.id)).toEqual([`now`]);
        // A different year spells it out; the same year does not, since the list is read as a diary.
        expect(dayOf(Date.UTC(2025, 0, 2, 12), NOON, `en-GB`)).toBe(`2 January 2025`);
    });
});
