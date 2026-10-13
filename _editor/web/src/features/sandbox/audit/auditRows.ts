import type { AuditActor, AuditRecord, AuditVerify } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { z } from "zod";

// How an audit record reads on screen. A record's action is a dotted name the daemon chose (`member.grant`,
// `secret.gate.set`); a person reads the first part as what was touched, in their own language, and the full name stays
// beside it for whoever compares it with an export.

// The parts an action name starts with, each with its word. An action this build has no word for reads as its own name.
const SUBJECTS = [
    `settings`,
    `privacy`,
    `member`,
    `area`,
    `secret`,
    `capability`,
    `approval`,
    `grant`,
    `safety`,
    `persona`,
    `automation`,
    `extension`,
    `environment`,
    `card`,
    `conversation`,
    `workspace`,
    `auth`,
    `passkey`,
    `token`,
    `export`,
    `definition`,
    `share`,
    `public`,
    `audit`,
    `file`,
    `activity`,
] as const;
type Subject = (typeof SUBJECTS)[number];

const SUBJECT_SET = new Set<string>(SUBJECTS);
const isSubject = (part: string): part is Subject => SUBJECT_SET.has(part);

const subjectWord = (subject: Subject): string => t(`sandbox.sandboxAudit.subject.${subject}`);

export const actionTitle = (action: string): string => {
    const [first = ``] = action.split(`.`);
    return isSubject(first) ? subjectWord(first) : action;
};

// A tier in the words the Access tab uses for it; a role this build does not know (or `unverified`, a passkey whose
// holder the roster refused) reads as the daemon wrote it.
const roleWord = (role: string): string => {
    switch (role) {
        case `owner`: {
            return t(`sandbox.sandboxAccess.wordOwner`);
        }
        case `maintainer`:
        case `writer`:
        case `collaborator`:
        case `viewer`:
        case `guest`: {
            return t(`sandbox.sandboxAccess.${role}`);
        }
        default: {
            return role;
        }
    }
};

export const actorLine = (actor: AuditActor): string => {
    switch (actor.kind) {
        case `member`: {
            return t(`sandbox.sandboxAudit.actorMember`, { email: actor.email, role: roleWord(actor.role) });
        }
        case `token`: {
            return t(`sandbox.sandboxAudit.actorToken`, { label: actor.label });
        }
        case `agent`: {
            return t(`sandbox.sandboxAudit.actorAgent`, { id: actor.conversationId });
        }
        default: {
            return actor.reason === undefined ? t(`sandbox.sandboxAudit.actorSystem`) : t(`sandbox.sandboxAudit.actorSystemBecause`, { reason: actor.reason });
        }
    }
};

// The filter's choices, each one prefix the daemon narrows by; empty is everything.
export const actionFilters = (): readonly { readonly label: string; readonly value: string }[] => [
    { label: t(`sandbox.sandboxAudit.filterAll`), value: `` },
    { label: subjectWord(`member`), value: `member.` },
    { label: t(`sandbox.sandboxAudit.filterSignIns`), value: `auth.` },
    { label: subjectWord(`settings`), value: `settings.` },
    { label: subjectWord(`secret`), value: `secret.` },
    { label: subjectWord(`conversation`), value: `conversation.` },
];

// The verdict of a chain check as one sentence, and how worried it should make the reader.
export interface VerdictLine {
    readonly tone: `success` | `danger`;
    readonly text: string;
}

export const verdictLine = (verdict: AuditVerify): VerdictLine => {
    if (verdict.broken === undefined) {
        return { tone: `success`, text: t(`sandbox.sandboxAudit.chainIntact`, { count: verdict.checked }, verdict.checked) };
    }
    const reason = t(`sandbox.sandboxAudit.broken.${verdict.broken.reason}`);
    return { tone: `danger`, text: t(`sandbox.sandboxAudit.chainBroken`, { file: verdict.broken.segment, line: verdict.broken.line, reason }) };
};

// The settings a change touched, as the daemon writes them (audit/settings-diff.ts): a key, and the old and new value
// where it is a switch or a number.
const SettingChangesSchema = z.array(z.object({ key: z.string(), from: z.union([z.boolean(), z.number()]).optional(), to: z.union([z.boolean(), z.number()]).optional() }));

const changeLine = (change: z.infer<typeof SettingChangesSchema>[number]): string =>
    change.from === undefined && change.to === undefined ? change.key : `${change.key}: ${String(change.from ?? `–`)} → ${String(change.to ?? `–`)}`;

// What a record's details say, as lines for the drawer under its row: one per changed setting, `key: value` otherwise.
export const detailLines = (record: AuditRecord): string[] =>
    Object.entries(record.details ?? {}).flatMap(([key, value]) => {
        const changes = key === `changed` ? SettingChangesSchema.safeParse(value) : undefined;
        return changes?.success === true ? changes.data.map(changeLine) : [`${key}: ${JSON.stringify(value)}`];
    });

const DAY_MS = 86_400_000;

// A date field's value (`YYYY-MM-DD`, the reader's calendar day) as the first millisecond of that day, local time.
export const dayStart = (day: string): number | undefined => {
    const [year, month, date] = day.split(`-`).map(Number);
    if (year === undefined || month === undefined || date === undefined || [year, month, date].some((part) => !Number.isFinite(part))) {
        return undefined;
    }
    return new Date(year, month - 1, date).getTime();
};

// The period an export covers: from the start of its first day to the end of its last, both days included.
export const exportSpan = (from: string, to: string): { readonly from: number; readonly to: number } | undefined => {
    const start = dayStart(from);
    const end = dayStart(to);
    return start === undefined || end === undefined || end < start ? undefined : { from: start, to: end + DAY_MS };
};
