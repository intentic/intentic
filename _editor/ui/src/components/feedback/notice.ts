import type { IconName } from "../../icons/iconSets.js";

// Notice model behind <Notice>/<NoticeStack>: a sentence the app wrote (`title`), the raw cause below it (`detail`),
// and at most one way out (`action`). `tone` also orders several notices on screen.

export type NoticeTone = "danger" | "warning" | "info";

export interface NoticeAction {
    readonly label: string;
    readonly run: () => void;
}

export interface NoticeModel {
    // `danger` broke what the user was doing; `warning` will if ignored; `info` needs no action.
    readonly tone: NoticeTone;
    // The app's own words; a caught message goes in `detail`, not here.
    readonly title: string;
    // The raw cause, when it says something the title doesn't.
    readonly detail?: string;
    readonly action?: NoticeAction;
    // Identity for duplicate collapsing; defaults to the title, override when one sentence covers several failures.
    readonly key?: string;
}

// Spelled out per tone, not templated: Tailwind only emits a utility it can see used literally.
export const NOTICE_BOX: Record<NoticeTone, string> = {
    danger: `flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger`,
    warning: `flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning`,
    info: `flex items-start gap-2 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-xs text-info`,
};

export const NOTICE_ICON: Record<NoticeTone, IconName> = {
    danger: `exclamation-triangle`,
    warning: `exclamation-circle`,
    info: `info-circle`,
};

export const noticeKey = (notice: NoticeModel): string => notice.key ?? notice.title;

// Ranks by severity, then original order; the first of duplicate notices survives, not the last.
const SEVERITY: readonly NoticeTone[] = [`danger`, `warning`, `info`];

export const rankNotices = (notices: readonly NoticeModel[]): readonly NoticeModel[] => {
    const seen = new Set<string>();
    const unique = notices.filter((notice) => {
        const key = noticeKey(notice);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    return unique
        .map((notice, index) => ({ notice, index }))
        .toSorted((left, right) => SEVERITY.indexOf(left.notice.tone) - SEVERITY.indexOf(right.notice.tone) || left.index - right.index)
        .map((entry) => entry.notice);
};
