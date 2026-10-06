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
export const NOTICE_TONE: Record<NoticeTone, string> = {
    danger: `border-danger/40 bg-danger/10 text-danger`,
    warning: `border-warning/40 bg-warning/10 text-warning`,
    info: `border-info/40 bg-info/10 text-info`,
};

// `xs`: a line inside a list or popover (a truncated result set). `sm`: a strip in a narrow column (the chat pane's).
// `md`: the default, in a form or a card. `lg`: a page's own banner, read at body size.
export type NoticeSize = "xs" | "sm" | "md" | "lg";

export const NOTICE_SIZE: Record<NoticeSize, string> = {
    xs: `gap-1 rounded px-2 py-0.5 text-2xs`,
    sm: `gap-x-2 gap-y-1 rounded-xl px-3 py-2 text-2xs`,
    md: `gap-2 rounded-lg px-3 py-2 text-xs`,
    lg: `gap-2 rounded-lg px-4 py-3 text-sm`,
};

// The glyph steps down with the type at `xs`, where the box is one short line.
export const NOTICE_ICON_SIZE: Record<NoticeSize, string> = {
    xs: `mt-0.5 text-[0.6rem]`,
    sm: `mt-px`,
    md: `mt-px`,
    lg: `mt-0.5`,
};

/** The box's whole class list: base, tone, size, and the wrapping layout a row of actions needs. */
export const noticeBox = (tone: NoticeTone, size: NoticeSize, actions: boolean): string =>
    `flex border text-left ${actions ? `flex-wrap items-center` : `items-start`} ${NOTICE_TONE[tone]} ${NOTICE_SIZE[size]}`;

export const NOTICE_ICON: Record<NoticeTone, IconName> = {
    danger: `exclamation-circle`,
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
