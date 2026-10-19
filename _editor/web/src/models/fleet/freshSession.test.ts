import "@intentic/testing/dom";
import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";
import { t } from "@intentic/ui/i18n";
import { NO_ATTENTION } from "../agent-status/agentStatus-lanes";
import { canStartFresh, checksOf, freshDraft } from "./freshSession";
import type { FleetAgent } from "./useAgents-fleet";

// Pins what a fresh session opens with for each kind and harness, which cards may start one, and what the origin's card
// says of its latest code review: a fresh session's outranks the agent's own, a running one says so, and either goes
// stale once the work changed after it.

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});
const command = (name: string): AgentCommand => ({ name, description: name });

const WORK = { branch: `agent/sleek-arrow-uzgj`, diff: { files: 3, insertions: 10, deletions: 2 } } as const;

describe(`what a fresh session opens with`, () => {
    it(`asks each harness's own reviewer by its published name, and in words where there is none`, () => {
        expect(freshDraft(`review`, [command(`code-review`), command(`init`)])).toBe(`/code-review `);
        expect(freshDraft(`review`, [command(`review`)])).toBe(`/review `);
        expect(freshDraft(`review`, [])).toBe(t(`agents.freshSession.reviewInWords`));
    });

    it(`asks for a test pass in words, and leaves the reader's own ask empty`, () => {
        expect(freshDraft(`test`, [command(`code-review`)])).toBe(t(`agents.freshSession.testInWords`));
        expect(freshDraft(`ask`, [command(`code-review`)])).toBe(``);
    });
});

describe(`which cards a fresh session can start on`, () => {
    it(`takes work on a private copy here that has something in it`, () => {
        expect(canStartFresh(card(`a`, WORK))).toBe(true);
    });

    it(`refuses the main tree, a runner's copy, an empty branch, an archived card, another box's, and a fresh session itself`, () => {
        expect(canStartFresh(card(`a`, { diff: WORK.diff }))).toBe(false);
        expect(canStartFresh(card(`a`, { ...WORK, runner: `laptop` }))).toBe(false);
        expect(canStartFresh(card(`a`, { ...WORK, diff: { files: 0, insertions: 0, deletions: 0 } }))).toBe(false);
        expect(canStartFresh(card(`a`, { ...WORK, archivedAt: 5 }))).toBe(false);
        expect(canStartFresh(card(`a`, { ...WORK, sandboxId: `other` }))).toBe(false);
        expect(canStartFresh(card(`a`, { ...WORK, fresh: { of: `o`, kind: `review`, at: 1 } }))).toBe(false);
    });
});

describe(`the markers on the origin's card`, () => {
    const origin = card(`o`, { ...WORK, proof: { at: 2_000, verification: `verified` } });
    const check = (id: string, kind: `review` | `test`, at: number, over: Partial<FleetAgent> = {}): FleetAgent =>
        card(id, { fresh: { of: `o`, kind, at }, startedBy: `agent:o`, turns: 1, ...over });

    it(`says nothing of a check that never ran`, () => {
        expect(checksOf(origin, [origin])).toEqual([]);
        // Its first message still held: nothing has looked yet.
        expect(checksOf(origin, [origin, check(`r`, `review`, 3_000, { turns: undefined })])).toEqual([]);
    });

    it(`draws one marker per kind of check, the latest of each, side by side`, () => {
        const older = check(`r1`, `review`, 3_000, { review: { at: 3_500, source: `claude`, findings: 5, open: 5 } });
        const newer = check(`r2`, `review`, 4_000, { review: { at: 4_500, source: `claude`, findings: 3, open: 1 } });
        const tested = check(`t1`, `test`, 4_200);
        expect(checksOf(origin, [origin, older, newer, tested])).toEqual([
            { kind: `review`, by: `r2`, own: false, state: `findings`, findings: 3, open: 1, stale: false },
            { kind: `test`, by: `t1`, own: false, state: `done`, stale: false },
        ]);
    });

    it(`says a check is running while its turn works, came back clean, or did not finish`, () => {
        expect(checksOf(origin, [origin, check(`r`, `review`, 3_000, { status: `running`, turns: undefined })])).toMatchObject([
            { state: `running`, stale: false },
        ]);
        expect(checksOf(origin, [origin, check(`r`, `review`, 3_000, { review: { at: 3_500, source: `codex`, findings: 0, open: 0 } })])).toMatchObject([
            { state: `clean` },
        ]);
        expect(checksOf(origin, [origin, check(`t`, `test`, 3_000, { status: `error`, failure: `boom` })])).toMatchObject([{ kind: `test`, state: `failed` }]);
    });

    it(`calls a check stale once the origin's work changed after it began`, () => {
        const changed = { ...origin, proof: { at: 5_000, verification: `unproven` as const } };
        expect(checksOf(changed, [changed, check(`t`, `test`, 3_000)])).toMatchObject([{ kind: `test`, stale: true }]);
    });

    it(`falls back to a review the agent ran in its own chat, marked as its own`, () => {
        const reviewedItself = { ...origin, review: { at: 2_000, source: `claude` as const, findings: 4, open: 4 } };
        expect(checksOf(reviewedItself, [reviewedItself])).toEqual([{ kind: `review`, by: `o`, own: true, stale: false, state: `findings`, findings: 4, open: 4 }]);
    });

    it(`ignores the reader's own ask, another origin's checks, and an archived one`, () => {
        const asked = card(`a`, { fresh: { of: `o`, kind: `ask`, at: 3_000 }, turns: 1 });
        const elsewhere = card(`x`, { fresh: { of: `other`, kind: `review`, at: 3_000 }, turns: 1 });
        const filed = check(`r`, `review`, 3_000, { archivedAt: 9_000, review: { at: 3_500, source: `claude`, findings: 1, open: 1 } });
        expect(checksOf(origin, [origin, asked, elsewhere, filed])).toEqual([]);
    });
});
