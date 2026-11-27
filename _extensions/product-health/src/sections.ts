import { formatCount, formatDate, timeAgo } from "@intentic/extension-ui/format";
import { t } from "./i18n.js";
import { isSnoozed, owedOf } from "./owed";
import type { Finding } from "./wire";

/* HOW THE VIEW READS THE SNAPSHOT: which section a finding sits in, in the order they owe a decision, and the one line
   under its title. Pure, so the order that decides what a reader sees first is tested without a browser. */

export type SectionId = `fix` | `waiting` | `step` | `working` | `decide` | `setup` | `watch` | `snoozed`;

// Owed first (nobody on it, then the agent waiting on the reader, then the owner's own step), then what needs nobody.
const SECTION_ORDER: readonly SectionId[] = [`fix`, `waiting`, `step`, `working`, `decide`, `setup`, `watch`, `snoozed`];

const sectionOf = (finding: Finding, now: number): SectionId => {
    if (isSnoozed(finding, now)) {
        return `snoozed`;
    }
    const owes = owedOf(finding, now);
    if (owes === `unowned` || owes === `handed-back`) {
        return `fix`;
    }
    if (owes === `answer` || owes === `review` || owes === `landed`) {
        return `waiting`;
    }
    if (owes === `step`) {
        return `step`;
    }
    return finding.lane === `fix` ? `working` : finding.lane === `step` ? `step` : finding.lane;
};

export interface Section {
    readonly id: SectionId;
    readonly findings: readonly Finding[];
}

export const sectionsOf = (findings: readonly Finding[], now: number): Section[] =>
    SECTION_ORDER.map((id) => ({ id, findings: findings.filter((finding) => sectionOf(finding, now) === id) })).filter((section) => section.findings.length > 0);

const DAY_MS = 24 * 60 * 60_000;

// What a row says under its title, by source: numbers PostHog measured where there are some, else its own sentence.
type Describer = (finding: Finding, now: number) => readonly (string | undefined)[];
const describers = {
    error: (finding, now) => [
        finding.impact?.occurrences === undefined ? undefined : t(`describe.times`, { count: formatCount(finding.impact.occurrences) }, finding.impact.occurrences),
        finding.impact?.users === undefined ? undefined : t(`describe.users`, { count: formatCount(finding.impact.users) }, finding.impact.users),
        finding.since === undefined ? undefined : t(`describe.since`, { when: timeAgo(finding.since, { now }) }),
    ],
    alert: (finding, now) => [
        finding.lane === `fix`
            ? finding.since === undefined
                ? t(`describe.firingNow`)
                : t(`describe.firing`, { when: timeAgo(finding.since, { now }) })
            : finding.lane === `setup`
              ? t(`describe.broken`)
              : t(`describe.quiet`),
        finding.summary === `` || finding.summary === finding.title ? undefined : finding.summary,
    ],
    health: (finding) => [finding.summary],
    report: (finding) => [finding.summary],
    setup: () => [],
    experiment: (finding, now) => [finding.kind === `ended` ? t(`describe.ended`) : t(`describe.running`, { days: Math.floor((now - (finding.since ?? now)) / DAY_MS) })],
} satisfies Record<Finding[`source`], Describer>;

export const descriptionOf = (finding: Finding, now: number, otherConnection: boolean): string =>
    [
        ...describers[finding.source](finding, now),
        finding.snoozedUntil !== undefined && finding.snoozedUntil > now ? t(`describe.snoozedUntil`, { when: formatDate(finding.snoozedUntil) }) : undefined,
        otherConnection ? t(`describe.otherConnection`, { connection: finding.connection }) : undefined,
    ]
        .filter((part) => part !== undefined && part !== ``)
        .join(` · `);

// A setup recommendation's title in the reader's language, when this extension knows its type.
const SETUP_TYPES: ReadonlySet<string> = new Set([`alerts`, `source_maps`, `rate_limits`, `issue_summaries`, `long_running_issues`]);
export const titleOf = (finding: Finding): string => (finding.source === `setup` && SETUP_TYPES.has(finding.kind) ? t(`setup.${finding.kind}`) : finding.title);
