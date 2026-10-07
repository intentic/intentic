import type { AutomationSummary, WatchSource } from "@intentic/sandbox-contract";
import { formatDateTime } from "@intentic/extension-ui/format";
import { since } from "./cronSchedule";
import { t } from "./i18n.js";

// How a watch reads in the list: what it looks at, and one line on where it stands. The daemon words its own run
// details; these are the screen's words for the same facts, in the reader's language.

/** The source in a few words: "npm bun@>=1.4.3", "Releases of oven-sh/bun", a page's address. */
export const sourceLabel = (source: WatchSource): string => {
    switch (source.kind) {
        case `npm`: {
            const spec = source.range ?? source.tag;
            return t(`watch.npm`, { spec: spec === undefined ? source.package : `${source.package}@${spec}` });
        }
        case `github-release`:
            return source.prereleases === true ? t(`watch.releasesWithPre`, { repo: source.repo }) : t(`watch.releases`, { repo: source.repo });
        case `url`:
            return source.select === undefined ? source.url : t(`watch.pageMatching`, { url: source.url, select: source.select });
    }
};

// What a check saw can be a release's name and its address on two lines, or a whole page; the line keeps the first.
const firstLine = (text: string): string => text.split(`\n`)[0]?.trim() ?? ``;

type Watched = Pick<AutomationSummary, `watch` | `expiresAt` | `until` | `fireOn` | `source` | `target`>;

/**
 * Whether this automation is a watch, something a person asked to hear about when it happens, rather than a chore that
 * happens to have a guard: the daemon's own reading (scheduler.ts `isWatch`), plus an end date or a target that is not
 * a new agent, which only a watch is given. Its row leads with where it stands instead of with its prompt.
 */
export const isWatch = (automation: Watched): boolean =>
    automation.source !== undefined ||
    automation.fireOn === `change` ||
    automation.until === `first-fire` ||
    automation.expiresAt !== undefined ||
    (automation.target !== undefined && automation.target.kind !== `agent`);

/**
 * One line on where a watch stands: "Checked 2h ago · saw bun@1.4.2 · fired 5m ago · ends 12 Oct, 09:00". A failing
 * check's own sentence wins over an older value, since `waiting` is what the LAST check said. A source never checked
 * says so; a guard never checked says nothing, since a chore's guard is not news until it has run. Undefined for an
 * automation with nothing to say here.
 */
export const watchLine = (automation: Watched, now = Date.now()): string | undefined => {
    const { watch } = automation;
    const seen = watch?.value === undefined ? `` : firstLine(watch.value);
    const parts = [
        ...(watch !== undefined
            ? [t(`watch.checked`, { when: since(watch.checkedAt) })]
            : automation.source !== undefined
              ? [t(`watch.notChecked`)]
              : []),
        ...(watch?.waiting !== undefined
            ? [t(`watch.waiting`, { detail: firstLine(watch.waiting) })]
            : seen !== ``
              ? [t(`watch.saw`, { value: seen })]
              : []),
        ...(watch?.firedAt !== undefined ? [t(`watch.fired`, { when: since(watch.firedAt) })] : []),
        ...(automation.expiresAt === undefined
            ? []
            : [
                  automation.expiresAt <= now
                      ? t(`watch.ended`, { date: formatDateTime(automation.expiresAt) })
                      : t(`watch.ends`, { date: formatDateTime(automation.expiresAt) }),
              ]),
        ...(automation.until === `first-fire` ? [t(`watch.stopsAfterFirst`)] : []),
    ];
    return parts.length === 0 ? undefined : parts.join(` · `);
};
