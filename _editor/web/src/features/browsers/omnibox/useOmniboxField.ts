import type { SearchEngine } from "@intentic/sandbox-contract/schemas/browsing";
import { primaryHeld } from "@intentic/ui/keys";
import { computed, type ComputedRef, nextTick, type Ref, ref, watch } from "vue";
import { toUrl, wrappedUrl } from "../address";
import type { PageMarks } from "../bookmarks/bookmarkTree";
import { type InlineCompletion, markHistory, type OmniboxRow, rankOmnibox, type TabCandidate } from "./rank";
import { useBrowsingHistory } from "./useBrowsingHistory";
import { useSearchSuggestions } from "./useSearchSuggestions";

// The address bar's typing: what the field shows, what the dropdown offers, and every key a browser's own address bar
// answers. The field's text is written here rather than bound in the template, since an inline completion is text and a
// selection set together: "192" typed shows "192.168.0.168" with ".168.0.168" selected, so the next keystroke replaces
// the rest, Tab or → keeps it, and Backspace takes it away without completing again.

export interface OmniboxFieldOptions {
    // The page's own address, shown while nobody types.
    readonly value: Ref<string>;
    readonly editable: Ref<boolean>;
    // Whose history the suggestions come from.
    readonly profile: Ref<string>;
    readonly engine: Ref<SearchEngine>;
    readonly tabs: Ref<readonly TabCandidate[]>;
    // The bookmarks and site icons the pages are marked with (bookmarks/bookmarkTree.ts).
    readonly marks: Ref<PageMarks>;
    readonly input: Ref<HTMLInputElement | undefined>;
    readonly submit: (url: string) => void;
    readonly switchTab: (tab: TabCandidate) => void;
    readonly cancel: () => void;
}

export interface OmniboxField {
    readonly focused: Ref<boolean>;
    // The field's text as it stands: what was typed, the inline completion, or the row picked with the arrows.
    readonly shown: ComputedRef<string>;
    readonly open: ComputedRef<boolean>;
    readonly rows: ComputedRef<readonly OmniboxRow[]>;
    readonly highlight: Ref<number>;
    readonly onFocus: () => void;
    readonly onBlur: () => void;
    readonly onInput: (event: Event) => void;
    readonly onKeydown: (event: KeyboardEvent) => void;
    readonly hover: (index: number) => void;
    readonly choose: (row: OmniboxRow) => void;
    readonly remove: (row: OmniboxRow) => void;
}

/** The next row the arrows land on: down past the last wraps to the first, and up past the first to the last. */
export const stepHighlight = (current: number, step: 1 | -1, count: number): number => (count === 0 ? 0 : (current + step + count) % count);

// Kinds a person can take out of the list (Shift+Delete, the row's ×): pages from history.
const removable = (row: OmniboxRow | undefined): row is Extract<OmniboxRow, { kind: `history` }> => row?.kind === `history`;

// What the field is in the middle of, between a focus and a blur.
interface FieldState {
    // What has been typed since focusing; undefined shows the page's address.
    readonly typed: Ref<string | undefined>;
    // Whether the last edit may complete inline: an insertion at the end may, a deletion never.
    readonly completing: Ref<boolean>;
    // Whether the dropdown is wanted: once typing starts, or ↓ asks for it.
    readonly wanted: Ref<boolean>;
    readonly highlight: Ref<number>;
    // Picked with the arrows: the field shows that row's text.
    readonly arrowed: Ref<boolean>;
}

const freshState = (): FieldState => ({ typed: ref(), completing: ref(false), wanted: ref(false), highlight: ref(0), arrowed: ref(false) });

const resetState = (state: FieldState): void => {
    state.typed.value = undefined;
    state.completing.value = false;
    state.wanted.value = false;
    state.highlight.value = 0;
    state.arrowed.value = false;
};

const pick = (state: FieldState, index: number): void => {
    state.highlight.value = index;
    state.arrowed.value = index !== 0;
};

// The ranked dropdown for the state, and the text the field shows for it.
const useRanking = (options: OmniboxFieldOptions, state: FieldState, focused: Ref<boolean>) => {
    const { history, refresh, forget } = useBrowsingHistory(options.profile);
    // Marked once per change of the history or the bookmarks, never per keystroke.
    const marked = computed(() => markHistory(history.value.prepared, options.marks.value));
    const text = computed(() => state.typed.value ?? ``);
    const asked = computed(() => focused.value && options.editable.value && state.wanted.value);
    const remote = useSearchSuggestions(text, options.engine, asked);
    const ranked = computed(() =>
        rankOmnibox({
            text: text.value,
            history: marked.value,
            tabs: options.tabs.value,
            terms: history.value.terms,
            remote: remote.value,
            engine: options.engine.value,
            complete: state.completing.value,
        }),
    );
    const open = computed(() => asked.value && ranked.value.rows.length > 0);
    const rows = computed(() => ranked.value.rows);
    const inline = computed<InlineCompletion | undefined>(() => (state.arrowed.value || state.highlight.value !== 0 ? undefined : ranked.value.inline));
    const shown = computed(() => {
        if (state.typed.value === undefined) {
            return options.value.value;
        }
        const picked = state.arrowed.value ? rows.value[state.highlight.value] : undefined;
        return picked?.fill ?? inline.value?.text ?? state.typed.value;
    });
    return { text, open, rows, inline, shown, refresh, forget };
};

type Ranking = ReturnType<typeof useRanking>;

// The keys a browser's address bar answers, over the state and the ranking.
const fieldKeys = (
    options: OmniboxFieldOptions,
    state: FieldState,
    ranking: Ranking,
    actions: { readonly finish: () => void; readonly choose: (row: OmniboxRow) => void; readonly remove: (row: OmniboxRow) => void },
): ((event: KeyboardEvent) => void) => {
    // Takes the inline completion as typed, so it stays once the selection is gone.
    const accept = (): boolean => {
        const completion = ranking.inline.value;
        if (completion === undefined) {
            return false;
        }
        state.typed.value = completion.text;
        state.completing.value = false;
        return true;
    };
    const enter = (event: KeyboardEvent): void => {
        const wrapped = primaryHeld(event) ? wrappedUrl(ranking.text.value) : undefined;
        const row = ranking.rows.value[state.highlight.value] ?? ranking.rows.value[0];
        if (wrapped === undefined && row !== undefined && ranking.text.value.trim() !== ``) {
            actions.choose(row);
            return;
        }
        const url = wrapped ?? toUrl(ranking.text.value, options.engine.value);
        actions.finish();
        if (url !== undefined) {
            options.submit(url);
        }
    };
    const escape = (): void => {
        if (!ranking.open.value && ranking.inline.value === undefined) {
            actions.finish();
            options.cancel();
            return;
        }
        // First Escape: the list and the completion go, what was typed stays.
        state.wanted.value = false;
        state.completing.value = false;
        pick(state, 0);
    };
    const arrow = (step: 1 | -1): void => {
        if (ranking.open.value) {
            pick(state, stepHighlight(state.highlight.value, step, ranking.rows.value.length));
        } else {
            state.wanted.value = true;
        }
    };
    // Tab takes a completion, else walks the list; past either end it leaves the field as Tab always does.
    const tab = (event: KeyboardEvent): void => {
        const next = state.highlight.value + (event.shiftKey ? -1 : 1);
        if (!event.shiftKey && accept()) {
            event.preventDefault();
        } else if (ranking.open.value && next >= 0 && next < ranking.rows.value.length) {
            event.preventDefault();
            pick(state, next);
        }
    };
    const prevented =
        (run: (event: KeyboardEvent) => void) =>
        (event: KeyboardEvent): void => {
            event.preventDefault();
            run(event);
        };
    const keys = new Map<string, (event: KeyboardEvent) => void>([
        [`Enter`, prevented(enter)],
        [`Escape`, prevented(escape)],
        [`ArrowDown`, prevented(() => arrow(1))],
        [`ArrowUp`, prevented(() => arrow(-1))],
        [`Tab`, tab],
        // The caret going to the end keeps the completion; the field's own move does the rest.
        [`ArrowRight`, () => void accept()],
        [`End`, () => void accept()],
        [
            `Delete`,
            (event) => {
                const row = ranking.open.value ? ranking.rows.value[state.highlight.value] : undefined;
                if (event.shiftKey && removable(row)) {
                    event.preventDefault();
                    actions.remove(row);
                }
            },
        ],
    ]);
    return (event) => {
        if (options.editable.value && !event.isComposing) {
            keys.get(event.key)?.(event);
        }
    };
};

export const useOmniboxField = (options: OmniboxFieldOptions): OmniboxField => {
    const { input } = options;
    const focused = ref(false);
    const state = freshState();
    const ranking = useRanking(options, state, focused);

    // The field follows `shown`; an inline completion selects what it added, so typing on replaces it. Painted once a
    // keystroke has changed everything it changes, never halfway (a sync watcher painted the completion of the text
    // before "v" over the "v" itself), and on every change from elsewhere (history arriving) before the next frame. Also
    // painted when `shown` did not change at all: typing "9" over a completion of "1" leaves it "192.168.0.168" both
    // times, while the field itself now says "19".
    const paint = (): void => {
        const field = input.value;
        const now = ranking.shown.value;
        if (field === undefined || field.value === now) {
            return;
        }
        field.value = now;
        const typed = state.typed.value;
        if (focused.value && typed !== undefined && now === ranking.inline.value?.text) {
            field.setSelectionRange(typed.length, now.length);
        }
    };
    watch([ranking.shown, input], paint, { immediate: true });

    const finish = (): void => {
        resetState(state);
        input.value?.blur();
    };
    const choose = (row: OmniboxRow): void => {
        finish();
        if (row.kind === `tab`) {
            options.switchTab(row.tab);
        } else {
            options.submit(row.url);
        }
    };
    const remove = (row: OmniboxRow): void => {
        if (removable(row)) {
            void ranking.forget({ kind: `urls`, urls: [row.url] });
        }
    };
    const keys = fieldKeys(options, state, ranking, { finish, choose, remove });

    return {
        focused,
        shown: ranking.shown,
        open: ranking.open,
        rows: ranking.rows,
        highlight: state.highlight,
        onFocus: () => {
            focused.value = true;
            if (options.editable.value) {
                state.typed.value = options.value.value;
                // A blank page's empty field offers the pages most worth going back to straight away.
                state.wanted.value = options.value.value === ``;
                void ranking.refresh();
            }
            // Focusing selects the whole address, so a click then Ctrl+C copies it, and typing replaces it. Only while
            // the field still has the keyboard: select() focuses a field in Chromium, so a field that lost it meanwhile
            // would take it back, and two fields focused in one tick (the address bar and the start page's box once the
            // last tab closes) would trade it forever in microtasks, freezing the whole app.
            void nextTick(() => {
                if (focused.value) {
                    input.value?.select();
                }
            });
        },
        onBlur: () => {
            focused.value = false;
            resetState(state);
        },
        onInput: (event) => {
            const field = input.value;
            if (field === undefined || !options.editable.value) {
                return;
            }
            const kind = event instanceof InputEvent ? event.inputType : `insertText`;
            const composing = event instanceof InputEvent && event.isComposing;
            // Only typing at the end completes: an edit in the middle, a deletion, or a word still being composed doesn't.
            const atEnd = field.selectionEnd === field.value.length;
            state.typed.value = field.value;
            state.completing.value = kind.startsWith(`insert`) && !composing && atEnd;
            state.wanted.value = true;
            pick(state, 0);
            paint();
        },
        onKeydown: (event) => {
            keys(event);
            paint();
        },
        hover: (index) => {
            state.highlight.value = index;
            state.arrowed.value = false;
        },
        choose,
        remove,
    };
};
