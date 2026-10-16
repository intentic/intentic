import type { AuditExport, AuditList, AuditQuery, AuditRecord, AuditStatus, AuditVerify } from "@intentic/sandbox-contract/schemas/audit";

// A short audit trail for the Audit log page, over three days: a member granted, a setting changed, sign-ins, a refused
// attempt, a read, and presses the daemon wrote twice in a moment. The hashes are placeholders, not a real chain: the
// demo has no daemon to seal one, and the page only shows them.

const MINUTE = 60_000;
const at = (minutesAgo: number): number => Date.now() - minutesAgo * MINUTE;
const hash = (n: number): string => n.toString(16).padStart(64, `0`);

const owner = { kind: `member`, email: `owner@example.com`, role: `owner` } as const;
const clerk = { kind: `member`, email: `anna.nowak@example.gov.pl`, role: `viewer` } as const;

const sandbox = { kind: `system`, reason: `sandbox credential` } as const;
const DAY = 24 * 60;

// The editor reaches the daemon with the sandbox's own credential and the member's session at once, so one press is
// often written twice in the same moment: the page folds those into one row, and the trail below shows it doing so.
const rows: Omit<AuditRecord, `v` | `id` | `prevHash` | `hash`>[] = [
    { at: at(2), actor: clerk, action: `conversation.read`, target: `c-budget-review` },
    { at: at(9), actor: clerk, action: `secret.gate.remove`, target: `EZD_TOKEN`, outcome: `refused` },
    { at: at(14), actor: clerk, action: `auth.sign_in`, details: { methods: [`passkey`] } },
    { at: at(31), actor: owner, action: `conversation.break_policy`, target: `c-budget-review` },
    { at: at(31), actor: sandbox, action: `conversation.break_policy`, target: `c-budget-review` },
    { at: at(40), actor: owner, action: `settings.change`, details: { changed: [{ key: `audit.recordReads`, from: false, to: true }, { key: `audit.retentionDays`, from: 365, to: 730 }] } },
    { at: at(41), actor: owner, action: `member.grant`, target: `anna.nowak@example.gov.pl`, details: { role: `viewer`, previousRole: `none`, areas: [`finance`] } },
    { at: at(60), actor: { kind: `system`, reason: `retention` }, action: `audit.pruned`, details: { segments: [`2024-09.jsonl`], retentionDays: 730 } },
    { at: at(75), actor: owner, action: `auth.sign_in`, details: { methods: [`google`] } },
    { at: at(DAY + 30), actor: owner, action: `privacy.reveal` },
    { at: at(DAY + 30), actor: sandbox, action: `privacy.reveal` },
    { at: at(DAY + 31), actor: sandbox, action: `privacy.vault.learn` },
    { at: at(DAY + 95), actor: owner, action: `capability.add`, target: `github` },
    { at: at(DAY + 96), actor: sandbox, action: `privacy.policy.change` },
    { at: at(DAY + 140), actor: { kind: `token`, id: `t-ci`, label: `CI` }, action: `token.mint`, target: `deploy-bot` },
    { at: at(DAY + 200), actor: owner, action: `card.answer`, target: `c-quarterly-report`, details: { kind: `question` } },
    { at: at(3 * DAY + 12), actor: owner, action: `compliance.preset.apply`, target: `public-office` },
    { at: at(3 * DAY + 13), actor: owner, action: `secret.set`, target: `EZD_TOKEN` },
    { at: at(3 * DAY + 50), actor: owner, action: `auth.sign_in`, details: { methods: [`google`] } },
];

export const demoAuditRecords: readonly AuditRecord[] = rows.map((row, index) => ({
    ...row,
    v: 1,
    id: `demo-audit-${index}`,
    prevHash: hash(rows.length - index - 1),
    hash: hash(rows.length - index),
}));

export const demoAuditList = (query: AuditQuery): AuditList => ({
    records: demoAuditRecords
        .filter((record) => query.action === undefined || record.action.startsWith(query.action))
        .filter((record) => query.actor === undefined || (record.actor.kind === `member` && record.actor.email.includes(query.actor.toLowerCase())))
        .slice(0, query.limit),
});

export const demoAuditVerify = (): AuditVerify => ({ ok: true, checked: demoAuditRecords.length, segments: 1, torn: false });

export const demoAuditStatus = (): AuditStatus => ({ segments: [`2026-10.jsonl`], oldestAt: demoAuditRecords.at(-1)?.at ?? Date.now() });

export const demoAuditExport = (from: number, to: number): AuditExport => {
    const lines = demoAuditRecords.filter((record) => record.at >= from && record.at < to).toReversed().map((record) => JSON.stringify(record));
    return { filename: `audit-demo.jsonl`, jsonl: lines.length === 0 ? `` : `${lines.join(`\n`)}\n`, count: lines.length };
};
