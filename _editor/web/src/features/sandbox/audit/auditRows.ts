import type { AuditActor, AuditRecord, AuditVerify } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { formatDayHeading } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { z } from "zod";

// How an audit record reads on screen. A record's action is a dotted name the daemon chose (`member.grant`,
// `secret.gate.set`); a person reads it as what happened ("Access granted"), under a glyph for the part of the sandbox
// it touched, and the full name stays in the record's drawer for whoever compares it with an export.

// The parts an action name starts with, each with its word and glyph. An action this build has no word for reads as
// its own name.
const SUBJECTS = {
    settings: `cog`,
    privacy: `eye-slash`,
    member: `users`,
    area: `folder`,
    secret: `key`,
    capability: `sitemap`,
    approval: `approvals`,
    grant: `shield`,
    safety: `shield`,
    persona: `user`,
    automation: `automations`,
    extension: `extensions`,
    environment: `box`,
    card: `question-circle`,
    conversation: `comments`,
    workspace: `folder-open`,
    auth: `sign-in`,
    passkey: `key`,
    token: `code`,
    export: `download`,
    definition: `file-edit`,
    share: `link`,
    public: `cloud-upload`,
    audit: `list-check`,
    compliance: `lock`,
    ai_notice: `sparkles`,
    retention: `trash`,
    file: `file`,
    activity: `wave-pulse`,
} as const satisfies Record<string, IconName>;
type Subject = keyof typeof SUBJECTS;

const isSubject = (part: string): part is Subject => Object.hasOwn(SUBJECTS, part);
const subjectOf = (action: string): Subject | undefined => {
    const [first = ``] = action.split(`.`);
    return isSubject(first) ? first : undefined;
};

const subjectWord = (subject: Subject): string => t(`sandbox.sandboxAudit.subject.${subject}`);

// Every action the daemon writes (audit/audit-http.ts, and the sweeps that record as the sandbox itself), each with a
// sentence under `act` in the catalog, its dots as dashes. One this build does not list reads as its subject and name.
const ACTIONS = new Set([
    `settings.change`,
    `settings.agent_domain.change`,
    `settings.repo_checks.adopt`,
    `privacy.policy.change`,
    `privacy.vault.learn`,
    `privacy.vault.forget`,
    `privacy.reveal`,
    `member.grant`,
    `member.remove`,
    `member.leave`,
    `area.save`,
    `area.remove`,
    `secret.set`,
    `secret.generate`,
    `secret.remove`,
    `secret.reveal`,
    `secret.gate.set`,
    `secret.gate.remove`,
    `secret.hosts.set`,
    `secret.policy.set`,
    `secret.provide`,
    `capability.add`,
    `capability.remove`,
    `capability.secret.set`,
    `capability.otp.read`,
    `approval.answer`,
    `approval.decide`,
    `approval.remove`,
    `approval.hooks.approve`,
    `approval.hooks.dismiss`,
    `grant.revoke`,
    `safety.policy.change`,
    `persona.save`,
    `persona.remove`,
    `persona.prompt.save`,
    `persona.skill.save`,
    `persona.skill.remove`,
    `automation.approve`,
    `automation.reject`,
    `extension.approve`,
    `environment.approve`,
    `environment.reject`,
    `card.answer`,
    `conversation.discard`,
    `conversation.purge`,
    `conversation.break_policy`,
    `conversation.read`,
    `workspace.restore`,
    `auth.sign_in`,
    `auth.sign_in_recovery`,
    `auth.sessions.revoke`,
    `auth.access.disable`,
    `passkey.add`,
    `passkey.remove`,
    `passkey.policy.set`,
    `passkey.recovery.regenerate`,
    `token.mint`,
    `token.revoke`,
    `export.bundle.create`,
    `export.bundle.delete`,
    `export.bundle.download`,
    `export.workspace.download`,
    `export.compliance.document`,
    `definition.publish`,
    `share.create`,
    `share.update`,
    `share.remove`,
    `public.publish`,
    `public.unpublish`,
    `audit.export`,
    `audit.read`,
    `audit.verify`,
    `audit.pruned`,
    `audit.settings.changed_outside`,
    `audit.torn_write_dropped`,
    `compliance.preset.apply`,
    `compliance.read`,
    `ai_notice.confirm`,
    `ai_notice.confirmations.read`,
    `retention.delete`,
    `file.read`,
    `activity.read`,
]);

/** What happened, as a reader says it: "Access granted". An action this build has no sentence for keeps its name. */
export const actionTitle = (action: string): string => {
    if (ACTIONS.has(action)) {
        return t(`sandbox.sandboxAudit.act.${action.replaceAll(`.`, `-`)}`);
    }
    const subject = subjectOf(action);
    return subject === undefined ? action : `${subjectWord(subject)} · ${action}`;
};

/** The glyph for the part of the sandbox an action touched. */
export const actionIcon = (action: string): IconName => {
    const subject = subjectOf(action);
    return subject === undefined ? `info-circle` : SUBJECTS[subject];
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

/** Who did it, whole: the address and the tier they held, the key's name, the conversation, or why the sandbox acted. */
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

/** Who did it, at a list's column width: the address alone, the key's name, the conversation, or "Sandbox". */
export const actorShort = (actor: AuditActor): string => {
    switch (actor.kind) {
        case `member`: {
            return actor.email;
        }
        case `token`: {
            return t(`sandbox.sandboxAudit.actorTokenShort`, { label: actor.label });
        }
        case `agent`: {
            return t(`sandbox.sandboxAudit.actorAgentShort`, { id: actor.conversationId });
        }
        default: {
            return t(`sandbox.sandboxAudit.actorSystemShort`);
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
export const detailLines = ({ details }: Pick<AuditRecord, `details`>): string[] =>
    Object.entries(details ?? {}).flatMap(([key, value]) => {
        const changes = key === `changed` ? SettingChangesSchema.safeParse(value) : undefined;
        return changes?.success === true ? changes.data.map(changeLine) : [`${key}: ${JSON.stringify(value)}`];
    });

/* ---- A burst as one row ---- */

// One row of the list: a record, or a burst of records that say the same thing. The editor reaches the daemon with the
// sandbox's own credential and the member's session at once, so one press is often written twice in the same
// millisecond, and a run of identical records is one event to a reader. Every record stays in the row's drawer.
export interface AuditEntry {
    readonly key: string;
    readonly at: number;
    readonly action: string;
    readonly target: string | undefined;
    readonly outcome: AuditRecord[`outcome`];
    readonly details: AuditRecord[`details`];
    /** Newest first, as the list is. */
    readonly records: readonly AuditRecord[];
}

// How far apart two records may be and still be one burst: a person's press and its echo land within a second, a
// person doing the same thing twice on purpose is minutes apart.
const BURST_MS = 60_000;

const sameEvent = (a: AuditRecord, b: AuditRecord): boolean =>
    a.action === b.action &&
    a.target === b.target &&
    (a.outcome ?? `ok`) === (b.outcome ?? `ok`) &&
    JSON.stringify(a.details ?? {}) === JSON.stringify(b.details ?? {}) &&
    Math.abs(a.at - b.at) <= BURST_MS;

/** Records, newest first, with each run of the same action on the same target folded into one entry. */
export const toEntries = (records: readonly AuditRecord[]): AuditEntry[] => {
    const entries: { key: string; at: number; action: string; target: string | undefined; outcome: AuditRecord[`outcome`]; details: AuditRecord[`details`]; records: AuditRecord[] }[] = [];
    for (const record of records) {
        const open = entries.at(-1);
        const last = open?.records.at(-1);
        if (open !== undefined && last !== undefined && sameEvent(last, record)) {
            open.records.push(record);
            continue;
        }
        entries.push({ key: record.id, at: record.at, action: record.action, target: record.target, outcome: record.outcome, details: record.details, records: [record] });
    }
    return entries;
};

// Which of a burst's actors names it in the list: a person over a program, a program over an agent, an agent over the
// sandbox itself, since the sandbox's own credential is usually carrying someone else's press.
const ACTOR_RANK = { member: 0, token: 1, agent: 2, system: 3 } as const satisfies Record<AuditActor[`kind`], number>;

/** The actor a row names, and how many others share the burst. */
export interface EntryActor {
    readonly actor: AuditActor;
    readonly others: number;
}

export const entryActor = (entry: AuditEntry): EntryActor => {
    const distinct = [...new Map(entry.records.map((record) => [JSON.stringify(record.actor), record.actor])).values()];
    const [lead] = distinct.toSorted((a, b) => ACTOR_RANK[a.kind] - ACTOR_RANK[b.kind]);
    // SAFETY: an entry is built around at least one record, so it has at least one actor.
    return { actor: lead!, others: distinct.length - 1 };
};

/** One calendar day of the list, the reader's own: its heading, its rows, and how many records they hold. */
export interface AuditDay {
    readonly label: string;
    readonly entries: AuditEntry[];
    records: number;
}

/** Entries in runs of one calendar day each, newest first. */
export const byDay = (entries: readonly AuditEntry[], now: number = Date.now()): AuditDay[] => {
    const days: AuditDay[] = [];
    for (const entry of entries) {
        const label = formatDayHeading(entry.at, now);
        const open = days.at(-1);
        if (open?.label === label) {
            open.entries.push(entry);
            open.records += entry.records.length;
            continue;
        }
        days.push({ label, entries: [entry], records: entry.records.length });
    }
    return days;
};

/* ---- A period to download ---- */

const DAY_MS = 86_400_000;

// A date field's value (`YYYY-MM-DD`, the reader's calendar day) as the first millisecond of that day, local time.
export const dayStart = (day: string): number | undefined => {
    const [year, month, date] = day.split(`-`).map(Number);
    if (year === undefined || month === undefined || date === undefined || [year, month, date].some((part) => !Number.isFinite(part))) {
        return undefined;
    }
    return new Date(year, month - 1, date).getTime();
};

/** The reader's own calendar day, as a date field shows it and `exportSpan` reads it. */
export const localDay = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, `0`)}-${String(date.getDate()).padStart(2, `0`)}`;

// The periods offered with one press, each as the two days a person would otherwise pick.
export type ExportPreset = `thisMonth` | `lastMonth` | `last30`;

export interface DayPeriod {
    readonly from: string;
    readonly to: string;
}

export const presetDays = (preset: ExportPreset, today: Date): DayPeriod => {
    switch (preset) {
        case `thisMonth`: {
            return { from: localDay(new Date(today.getFullYear(), today.getMonth(), 1)), to: localDay(today) };
        }
        case `lastMonth`: {
            return { from: localDay(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: localDay(new Date(today.getFullYear(), today.getMonth(), 0)) };
        }
        default: {
            return { from: localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29)), to: localDay(today) };
        }
    }
};

/** The period an export covers: from the start of its first day to the end of its last, both days included. */
export const exportSpan = (from: string, to: string): { readonly from: number; readonly to: number } | undefined => {
    const start = dayStart(from);
    const end = dayStart(to);
    return start === undefined || end === undefined || end < start ? undefined : { from: start, to: end + DAY_MS };
};
