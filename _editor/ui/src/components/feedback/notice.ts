import { tv } from "tailwind-variants";
import type { IconName } from "../../icons/iconSets.js";
import { toneInk, toneTint } from "../../lib/tone.js";

// Notice model behind <Notice>/<NoticeStack>: a sentence the app wrote (`title`), the raw cause below it (`detail`),
// and at most one way out (`action`). `tone` also orders several notices on screen.

export type NoticeTone = "danger" | "warning" | "info" | "success";

export interface NoticeAction {
    readonly label: string;
    readonly run: () => void;
}

export interface NoticeModel {
    // `danger` broke what the user was doing; `warning` will if ignored; `info` needs no action; `success` says a step the
    // user took came off (a machine connected, an extension installed), where a hand-tinted green box used to.
    readonly tone: NoticeTone;
    // The app's own words; a caught message goes in `detail`, not here.
    readonly title: string;
    // The raw cause, when it says something the title doesn't.
    readonly detail?: string;
    readonly action?: NoticeAction;
    // Identity for duplicate collapsing; defaults to the title, override when one sentence covers several failures.
    readonly key?: string;
}

// `xs`: a line inside a list or popover (a truncated result set). `sm`: a strip in a narrow column (the chat pane's).
// `md`: the default, in a form or a card. `lg`: a page's own banner, read at body size.
export type NoticeSize = "xs" | "sm" | "md" | "lg";

// The box and its glyph as one recipe. The tone's colours are the kit's (tone.ts), at the strong weight every notice
// speaks at, with the tone's own ink; the size is the box's. `strip` is the same notice laid along a pane's top edge
// (a file that changed on disk, a truncated diff): full width, no radius, a rule only underneath.
const noticeRecipe = tv({
    slots: { box: `flex border text-left`, icon: `shrink-0` },
    variants: {
        tone: {
            danger: { box: [toneTint(`danger`), toneInk(`danger`)] },
            warning: { box: [toneTint(`warning`), toneInk(`warning`)] },
            info: { box: [toneTint(`info`), toneInk(`info`)] },
            success: { box: [toneTint(`success`), toneInk(`success`)] },
        },
        size: {
            xs: { box: `gap-1 rounded px-2 py-0.5 text-2xs`, icon: `text-[0.6rem]` },
            sm: { box: `gap-x-2 gap-y-1 rounded-xl px-3 py-2 text-2xs` },
            md: { box: `gap-2 rounded-lg px-3 py-2 text-xs` },
            lg: { box: `gap-2 rounded-lg px-4 py-3 text-sm` },
        },
        // A row of actions wraps under the sentence in a narrow column, and the glyph centres on the line it shares. Without
        // them the glyph leads the sentence's first line, placed there by `.ui-icon` (utilities.css), at every size.
        actions: { true: { box: `flex-wrap items-center` }, false: { box: `items-start` } },
        strip: { true: { box: `shrink-0 rounded-none border-x-0 border-t-0 py-1.5` } },
    },
    defaultVariants: { size: `md`, actions: false, strip: false },
});

/** The box's and the glyph's class lists for one notice; `box` takes the caller's own classes, merged last. */
export const noticeLook = (
    tone: NoticeTone,
    size: NoticeSize,
    actions: boolean,
    strip = false,
): { readonly box: (own?: string) => string; readonly icon: string } => {
    const look = noticeRecipe({ tone, size, actions, strip });
    return { box: (own) => look.box({ class: own }), icon: look.icon() };
};

/** The box's whole class list: base, tone, size, and the wrapping layout a row of actions needs. */
export const noticeBox = (tone: NoticeTone, size: NoticeSize, actions: boolean, strip = false): string =>
    noticeLook(tone, size, actions, strip).box();

export const NOTICE_ICON: Record<NoticeTone, IconName> = {
    danger: `exclamation-circle`,
    warning: `exclamation-circle`,
    info: `info-circle`,
    success: `check-circle`,
};

export const noticeKey = (notice: NoticeModel): string => notice.key ?? notice.title;

// Ranks by severity, then original order; the first of duplicate notices survives, not the last.
const SEVERITY: readonly NoticeTone[] = [`danger`, `warning`, `info`, `success`];

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
