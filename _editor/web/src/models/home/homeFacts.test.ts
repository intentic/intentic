import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { mergeAttention, orderedSandboxes, tileAction, workLedger, workStage } from "./homeFacts";

type Work = Parameters<typeof workStage>[0];
const worker = (overrides: Partial<Work> = {}): Work => ({ id: `worker`, status: `ready`, updatedAt: 10, startedBy: `agent:home`, ...overrides });
const check = (kind: `review` | `test`, status: AgentSummary[`status`], at: number): Work =>
    worker({ id: kind, status, updatedAt: at, fresh: { of: `worker`, by: `home`, kind, at } });

describe(`home tiles`, () => {
    test(`owners lead without changing order within memberships`, () => {
        expect(
            orderedSandboxes([
                { id: `a`, role: `viewer` },
                { id: `b`, role: `owner` },
                { id: `c`, role: `owner` },
                { id: `d`, role: `writer` },
            ]).map((box) => box.id),
        ).toEqual([`b`, `c`, `a`, `d`]);
    });
    test(`unanswered is unknown and a failed refresh retains the last count`, () => {
        expect(mergeAttention(undefined, undefined)).toEqual({ needsYou: undefined, unreachable: true });
        expect(mergeAttention(undefined, 0)).toEqual({ needsYou: 0, unreachable: false });
        expect(mergeAttention({ needsYou: 4, unreachable: false }, undefined)).toEqual({ needsYou: 4, unreachable: true });
        expect(mergeAttention({ needsYou: 4, unreachable: true }, 2)).toEqual({ needsYou: 2, unreachable: false });
    });
    test(`first click selects immediately; double press and Enter enter`, () => {
        expect(tileAction(`click`, false, 0)).toBe(`select`);
        expect(tileAction(`click`, true, 300)).toBe(`enter`);
        expect(tileAction(`click`, true, 301)).toBe(`select`);
        expect(tileAction(`click`, false, 100)).toBe(`select`);
        expect(tileAction(`enter`, false, Infinity)).toBe(`enter`);
    });
});
describe(`home ledger`, () => {
    test(`running workers take precedence over old checks`, () => {
        expect(workStage(worker({ status: `running` }), [check(`test`, `running`, 20)], undefined, 30)).toBe(`working`);
    });
    test(`running or newly finished checks show the kind being judged`, () => {
        expect(workStage(worker(), [check(`review`, `running`, 5)], undefined, 30)).toBe(`reviewing`);
        expect(workStage(worker(), [check(`review`, `idle`, 20), check(`test`, `idle`, 30)], undefined, 30)).toBe(`testing`);
        expect(workStage(worker(), [check(`test`, `idle`, 5)], undefined, 30)).toBe(`held`);
        expect(workStage(worker(), [check(`test`, `idle`, 20)], undefined, 30_021)).toBe(`held`);
    });
    test(`merged children follow a later home landing, never an earlier one`, () => {
        const merged = worker({ status: `landed`, updatedAt: 20 });
        expect(workStage(merged, [], worker({ id: `home`, status: `landed`, updatedAt: 10 }), 30)).toBe(`merged`);
        expect(workStage(merged, [], worker({ id: `home`, status: `landed`, updatedAt: 30 }), 30)).toBe(`landed`);
        expect(workStage(worker({ status: `error` }), [], undefined, 30)).toBe(`waiting`);
    });
    test(`the ledger carries the home landing subject after acceptance`, () => {
        const accepted = worker({ status: `landed`, updatedAt: 20, landedMessage: { subject: `fix: checkout` } });
        const home = worker({
            id: `home`,
            startedBy: undefined,
            status: `landed`,
            updatedAt: 30,
            landedMessage: { subject: `feat: accepted checkout` },
        });
        expect(workLedger([accepted, home], `home`, 30).map((row) => [row.stage, row.subject])).toEqual([[`landed`, `feat: accepted checkout`]]);
        expect(workLedger([accepted], `home`, 30).map((row) => [row.stage, row.subject])).toEqual([[`merged`, `fix: checkout`]]);
    });
    test(`checks belong under their worker only when this home requested them`, () => {
        const rows = workLedger(
            [
                worker(),
                check(`review`, `idle`, 20),
                worker({ id: `unrelated`, startedBy: `agent:other` }),
                worker({ id: `foreign`, fresh: { of: `worker`, by: `other`, kind: `test`, at: 30 } }),
            ],
            `home`,
            30,
        );
        expect(rows.map((row) => ({ id: row.worker.id, checks: row.checks.map((item) => item.id), stage: row.stage }))).toEqual([
            { id: `worker`, checks: [`review`], stage: `reviewing` },
        ]);
    });
});
