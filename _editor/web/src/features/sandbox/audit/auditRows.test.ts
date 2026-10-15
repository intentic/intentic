// Pins how an audit record reads: what happened in words, who did it, the chain check as one sentence, a burst of the
// same record as one row, and the export period covering both of the days a person picked.
import type { AuditRecord, AuditVerify } from "@intentic/sandbox-contract";
import { actionIcon, actionTitle, actorLine, actorShort, byDay, detailLines, entryActor, exportSpan, presetDays, toEntries, verdictLine } from "./auditRows";

test(`an action reads as what happened; one this build has no sentence for keeps its name, under its subject if known`, () => {
    expect(actionTitle(`member.grant`)).toBe(`Access granted`);
    expect(actionTitle(`secret.gate.set`)).toBe(`Secret approver set`);
    expect(actionTitle(`auth.sign_in`)).toBe(`Signed in`);
    expect(actionTitle(`secret.rotate`)).toBe(`Secrets · secret.rotate`);
    expect(actionTitle(`weather.change`)).toBe(`weather.change`);
    expect(actionIcon(`capability.add`)).toBe(`sitemap`);
    expect(actionIcon(`weather.change`)).toBe(`info-circle`);
});

test(`each kind of actor is named the way a reader recognises it`, () => {
    expect(actorLine({ kind: `member`, email: `ann@example.com`, role: `maintainer` })).toBe(`ann@example.com (Maintainer)`);
    expect(actorLine({ kind: `token`, id: `t1`, label: `CI` })).toBe(`Program with the key “CI”`);
    expect(actorLine({ kind: `agent`, conversationId: `c-1` })).toBe(`Agent in conversation c-1`);
    expect(actorLine({ kind: `system` })).toBe(`The sandbox itself`);
    expect(actorLine({ kind: `system`, reason: `retention` })).toBe(`The sandbox itself (retention)`);
    expect(actorShort({ kind: `member`, email: `ann@example.com`, role: `maintainer` })).toBe(`ann@example.com`);
    expect(actorShort({ kind: `system`, reason: `retention` })).toBe(`Sandbox`);
});

const auditRecord = (at: number, fields: Partial<AuditRecord> = {}): AuditRecord => ({
    v: 1,
    id: `r${at}`,
    at,
    actor: { kind: `system`, reason: `sandbox credential` },
    action: `capability.add`,
    prevHash: ``,
    hash: `h${at}`,
    ...fields,
});

test(`a press written twice in a moment is one row, named by the person rather than the sandbox's credential`, () => {
    const owner = { kind: `member`, email: `owner@example.com`, role: `owner` } as const;
    const entries = toEntries([
        auditRecord(5000, { action: `conversation.break_policy`, target: `c-1` }),
        auditRecord(4990, { action: `conversation.break_policy`, target: `c-1`, actor: owner }),
        auditRecord(4000, { action: `conversation.break_policy`, target: `c-2`, actor: owner }),
        auditRecord(3000, { action: `settings.change`, details: { changed: [{ key: `a` }] } }),
        auditRecord(2900, { action: `settings.change`, details: { changed: [{ key: `b` }] } }),
        auditRecord(2000, { outcome: `refused` }),
        auditRecord(1000),
    ]);
    expect(entries.map((entry) => entry.records.length)).toEqual([2, 1, 1, 1, 1, 1]);
    expect(entryActor(entries[0]!)).toEqual({ actor: owner, others: 1 });
    // The same action minutes apart is done twice, not echoed.
    expect(toEntries([auditRecord(10 * 60_000), auditRecord(1000)])).toHaveLength(2);
});

test(`rows fall under the reader's own day, today and yesterday by name`, () => {
    const now = new Date(2026, 9, 15, 12).getTime();
    const days = byDay(toEntries([auditRecord(new Date(2026, 9, 15, 9).getTime()), auditRecord(new Date(2026, 9, 15, 1).getTime(), { action: `auth.sign_in` }), auditRecord(new Date(2026, 9, 14, 23).getTime()), auditRecord(new Date(2026, 9, 12, 8).getTime())]), now);
    expect(days.map((day) => [day.label, day.records])).toEqual([
        [`Today`, 2],
        [`Yesterday`, 1],
        [`Monday, October 12`, 1],
    ]);
});

test(`the chain check is one sentence: intact with a count, or where it broke and how`, () => {
    const intact: AuditVerify = { ok: true, checked: 3, segments: 1, torn: false };
    expect(verdictLine(intact)).toEqual({ tone: `success`, text: `Intact: 3 records checked, none changed since they were written.` });
    const broken: AuditVerify = { ok: false, checked: 1, segments: 1, torn: false, broken: { segment: `2026-10.jsonl`, line: 2, reason: `hash-mismatch` } };
    expect(verdictLine(broken)).toEqual({
        tone: `danger`,
        text: `Changed after it was written: line 2 of 2026-10.jsonl. The content of that record was edited.`,
    });
});

test(`a settings change reads one line per key, other details as key and value`, () => {
    const record = {
        v: 1 as const,
        id: `r`,
        at: 1,
        actor: { kind: `system` as const },
        action: `settings.change`,
        details: { changed: [{ key: `chatPages`, from: true, to: false }, { key: `systemPrompt` }], segments: [`2025-07.jsonl`] },
        prevHash: ``,
        hash: ``,
    };
    expect(detailLines(record)).toEqual([`chatPages: true → false`, `systemPrompt`, `segments: ["2025-07.jsonl"]`]);
});

test(`an export covers both picked days whole, and a backwards period is refused`, () => {
    const span = exportSpan(`2026-10-01`, `2026-10-02`);
    expect(span).toEqual({ from: new Date(2026, 9, 1).getTime(), to: new Date(2026, 9, 3).getTime() });
    expect(exportSpan(`2026-10-02`, `2026-10-01`)).toBeUndefined();
    expect(exportSpan(``, `2026-10-01`)).toBeUndefined();
});

test(`each one-press period names the two days it covers`, () => {
    const today = new Date(2026, 0, 15);
    expect(presetDays(`thisMonth`, today)).toEqual({ from: `2026-01-01`, to: `2026-01-15` });
    expect(presetDays(`lastMonth`, today)).toEqual({ from: `2025-12-01`, to: `2025-12-31` });
    expect(presetDays(`last30`, today)).toEqual({ from: `2025-12-17`, to: `2026-01-15` });
});
