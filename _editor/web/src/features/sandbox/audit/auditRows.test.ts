// Pins how an audit record reads: the thing touched in words with the dotted name kept beside it, who did it, the
// chain check as one sentence, and the export period covering both of the days a person picked.
import type { AuditVerify } from "@intentic/sandbox-contract";
import { actionTitle, actorLine, detailLines, exportSpan, verdictLine } from "./auditRows";

test(`an action reads as the thing it touched, and an unknown one as its own name`, () => {
    expect(actionTitle(`member.grant`)).toBe(`People`);
    expect(actionTitle(`secret.gate.set`)).toBe(`Secrets`);
    expect(actionTitle(`retention.swept`)).toBe(`retention.swept`);
});

test(`each kind of actor is named the way a reader recognises it`, () => {
    expect(actorLine({ kind: `member`, email: `ann@example.com`, role: `maintainer` })).toBe(`ann@example.com (Maintainer)`);
    expect(actorLine({ kind: `token`, id: `t1`, label: `CI` })).toBe(`Program with the key “CI”`);
    expect(actorLine({ kind: `agent`, conversationId: `c-1` })).toBe(`Agent in conversation c-1`);
    expect(actorLine({ kind: `system` })).toBe(`The sandbox itself`);
    expect(actorLine({ kind: `system`, reason: `retention` })).toBe(`The sandbox itself (retention)`);
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
