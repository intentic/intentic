<!-- A hover preview of the file a `path:line` link names: the lines around that line, the top of a file named without one, or why there is nothing to show. -->
<script setup lang="ts">
import { AnchoredOverlay, type CodeToken, explorerColorClass, formatBytes, iconForEntry, useHighlighter, useHoverIntent, useLatest } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { basename, parentDir } from "@intentic/ui/path";
import { computed, ref, shallowRef, watch } from "vue";
import { sandboxRpc } from "../../../sandbox/client/sandboxRpc";
import { resolveFile } from "../../explorer/fileType";
import { readFileWindow } from "../fileWindow";
import { createPeekCache, PEEK_SPAN, peekKey, type PeekFile, type PeekIo, peekView, peekWantsMore, readPeek } from "./filePeek";
import { openWorkspaceRef, sharedStatePath } from "./openFileRef";
import { resolveWorkspaceRef } from "./resolveFileRef";

// One card per surface, raised by every file link inside `host` through delegated listeners (the links live in v-html,
// so no link carries a listener of its own). The pointer opens it after a dwell, keyboard focus at once; the pointer
// may cross into the card and rest there, and leaving both, Escape or a press closes it. The same links still open
// the file on click, and so does a press on the card.

const t = useT();

const { host } = defineProps<{
    // The surface whose file links raise the card (a pane's transcript): listened on, never rendered into.
    host: HTMLElement | undefined;
}>();

// A reference as its link carries it: the path as written (resolved on read), the line if any, and the tree it names.
interface PeekTarget {
    readonly written: string;
    readonly line: number | undefined;
    readonly agent: string | undefined;
}

const targetOf = (link: HTMLAnchorElement): PeekTarget | undefined => {
    const written = link.dataset[`file`];
    if (written === undefined || written === ``) {
        return undefined;
    }
    const line = Number(link.dataset[`line`]);
    // `.intentic` is the same folder in every tree, so it is read from the shared one, as opening it does.
    return { written, line: Number.isInteger(line) && line > 0 ? line : undefined, agent: sharedStatePath(written) ? undefined : link.dataset[`agent`] };
};

const sameTarget = (a: PeekTarget | undefined, b: PeekTarget): boolean => a?.written === b.written && a.line === b.line && a.agent === b.agent;

// Long enough that a pointer crossing a paragraph of links raises nothing, the close grace carries it over the gap into
// the card, and `warm` lets a reader sweep from one link to the next without waiting again.
const hover = useHoverIntent({ open: 350, close: 150, warm: 500 });
// Reading starts on a shorter dwell than the card opens on, so the card usually opens on the lines rather than their
// placeholder, while a pointer only passing over still reads nothing.
const prefetch = useHoverIntent({ open: 120 });

// The link the card hangs off while up; undefined is closed.
const anchor = shallowRef<HTMLAnchorElement>();
const target = shallowRef<PeekTarget>();
const file = shallowRef<PeekFile>();
const failed = ref(false);

// --- Reading: one cache per surface, so a second look at a file costs nothing and a stale one is read again. -------
const cache = createPeekCache({ freshFor: 30_000, budget: 4 * 1024 * 1024 });

const ioFor = (agent: string | undefined): PeekIo => {
    const scope = { agent };
    return {
        resolve: (path) => resolveWorkspaceRef(path, scope),
        read: (path, offset, limit) => readFileWindow(path, { offset, limit, scope }),
        list: async (path) => {
            const { entries } = await sandboxRpc.workspace.children({ path, agent });
            return { names: entries.map((entry) => entry.name), count: entries.length };
        },
    };
};

const enoughFor =
    (line: number | undefined) =>
    (held: PeekFile): boolean =>
        !peekWantsMore(held, line);

const fetchPeek = (next: PeekTarget): Promise<PeekFile> =>
    cache.load(peekKey(next.written, next.agent), (held) => readPeek(ioFor(next.agent), next.written, next.line, held), enoughFor(next.line));

const latest = useLatest();
const load = (next: PeekTarget): void => {
    const isLatest = latest();
    const held = cache.peek(peekKey(next.written, next.agent));
    failed.value = false;
    // Drawn at once when an earlier look already read enough; otherwise the card opens on its placeholder rows.
    file.value = held !== undefined && enoughFor(next.line)(held) ? held : undefined;
    if (file.value !== undefined) {
        return;
    }
    fetchPeek(next).then(
        (answer) => {
            if (isLatest()) {
                file.value = answer;
            }
        },
        () => {
            if (isLatest()) {
                failed.value = true;
            }
        },
    );
};

// --- Opening and closing. ---------------------------------------------------------------------------------------
const release = (): void => {
    anchor.value = undefined;
};

const raise = (link: HTMLAnchorElement): void => {
    const next = targetOf(link);
    if (next === undefined || !link.isConnected) {
        hover.hide(release);
        return;
    }
    anchor.value = link;
    // Replaced only when it names something else, so a pointer coming back to the same link redraws nothing.
    if (!sameTarget(target.value, next)) {
        target.value = next;
    }
    load(next);
};

// The overlay closes itself too (a press outside, the window losing focus, the link scrolled away), which the clock
// has to hear.
const open = computed({
    get: () => hover.shown.value && anchor.value !== undefined,
    set: (value: boolean) => {
        if (!value) {
            hover.hide(release);
        }
    },
});

// A link's own `title` (its full path) would raise the browser's tooltip over the card, saying less than the card does,
// so it is lifted off while the pointer is on the link and put back as the pointer leaves.
const quiet = (link: HTMLAnchorElement): void => {
    const title = link.getAttribute(`title`);
    if (title !== null) {
        link.dataset[`peekTitle`] = title;
        link.removeAttribute(`title`);
    }
};
const unquiet = (link: HTMLAnchorElement): void => {
    const title = link.dataset[`peekTitle`];
    if (title !== undefined) {
        link.setAttribute(`title`, title);
        delete link.dataset[`peekTitle`];
    }
};

// The file link an event is about, if it is one of this surface's. Not narrowed with `instanceof Element`, which a
// popped-out chat fails: its nodes belong to that window's realm.
const linkOf = (at: EventTarget | null): HTMLAnchorElement | undefined => {
    // SAFETY: every caller is a listener bound on `host`, whose pointer and focus events target an element inside it,
    // never a text node or the window.
    const link = (at as Element | null)?.closest<HTMLAnchorElement>(`a.md-file-link`) ?? null;
    return link !== null && host?.contains(link) === true ? link : undefined;
};

const onOver = (event: PointerEvent): void => {
    const link = linkOf(event.target);
    // A touch has no hover: its tap is the click that opens the file.
    if (link === undefined || event.pointerType === `touch`) {
        return;
    }
    quiet(link);
    const next = targetOf(link);
    if (next !== undefined) {
        prefetch.enter(() => void fetchPeek(next).catch(() => undefined));
    }
    hover.enter(() => raise(link));
};

const onOut = (event: PointerEvent): void => {
    const link = linkOf(event.target);
    // Moving between the link's own pieces (a `<code>` inside it) is not leaving it.
    // SAFETY: a pointerout's relatedTarget is the element the pointer went to, or null when it left the window.
    if (link === undefined || link.contains(event.relatedTarget as Node | null)) {
        return;
    }
    unquiet(link);
    prefetch.hide();
    hover.leave(release);
};

// Keyboard focus only: a press focuses the link too, on its way to opening the file.
const onFocusIn = (event: FocusEvent): void => {
    const link = linkOf(event.target);
    if (link !== undefined && link.matches(`:focus-visible`)) {
        hover.show(() => raise(link));
    }
};
const onFocusOut = (event: FocusEvent): void => {
    const link = linkOf(event.target);
    if (link !== undefined && link === anchor.value) {
        hover.hide(release);
    }
};
// The link's own click opens the file; the card has nothing left to say.
const onClick = (event: MouseEvent): void => {
    if (linkOf(event.target) !== undefined) {
        hover.hide(release);
    }
};

watch(
    () => host,
    (el, _previous, onCleanup) => {
        if (el === undefined) {
            return;
        }
        el.addEventListener(`pointerover`, onOver);
        el.addEventListener(`pointerout`, onOut);
        el.addEventListener(`focusin`, onFocusIn);
        el.addEventListener(`focusout`, onFocusOut);
        el.addEventListener(`click`, onClick);
        onCleanup(() => {
            el.removeEventListener(`pointerover`, onOver);
            el.removeEventListener(`pointerout`, onOut);
            el.removeEventListener(`focusin`, onFocusIn);
            el.removeEventListener(`focusout`, onFocusOut);
            el.removeEventListener(`click`, onClick);
            hover.hide(release);
        });
    },
    { immediate: true },
);

// While the card is up, its Escape closes it and nothing else: the card is the topmost thing, and one press undoes one
// thing (the composer's Escape stops a turn). Capture, on the anchor's own document, so it is heard first.
const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        event.stopPropagation();
        hover.hide(release);
    }
};
watch(
    () => (open.value ? anchor.value?.ownerDocument : undefined),
    (doc, _previous, onCleanup) => {
        if (doc === undefined) {
            return;
        }
        doc.addEventListener(`keydown`, onKeydown, true);
        onCleanup(() => doc.removeEventListener(`keydown`, onKeydown, true));
    },
);

const onCardLeave = (): void => hover.leave(release);

// A press on the card goes where the link goes, the resolved path and line in the link's own tree.
const openTarget = (): void => {
    const shown = target.value;
    if (shown === undefined) {
        return;
    }
    const path = file.value?.path ?? shown.written;
    hover.hide(release);
    void openWorkspaceRef(path, shown.line, { agent: shown.agent });
};

// --- What the card draws. -----------------------------------------------------------------------------------------
const view = computed(() => (file.value === undefined || target.value === undefined ? undefined : peekView(file.value, target.value.line)));

const shownPath = computed(() => file.value?.path ?? target.value?.written ?? ``);
const name = computed(() => basename(shownPath.value));
// The folder part ends in its slash, so the path reads whole when nothing is cut.
const folder = computed(() => {
    const parent = parentDir(shownPath.value);
    return parent === `` ? `` : `${parent}/`;
});
const entryType = computed(() => (view.value?.kind === `folder` ? `dir` : `file`));
const icon = computed(() => iconForEntry(name.value, entryType.value));
const iconColour = computed(() => explorerColorClass(`colorful`, name.value, entryType.value, false));

// The fact beside the path: how long the file is once known, how big bytes are, how much a folder holds.
const aside = computed(() => {
    const shown = view.value;
    if (shown?.kind === `lines` && shown.total !== undefined) {
        return t(`workspace.fileRefPeek.lines`, { count: shown.total.toLocaleString() }, shown.total);
    }
    if (shown?.kind === `binary`) {
        return formatBytes(shown.size);
    }
    if (shown?.kind === `folder`) {
        return t(`workspace.fileRefPeek.items`, { count: shown.count.toLocaleString() }, shown.count);
    }
    return undefined;
});

// The one line the card says in place of code.
const note = computed(() => {
    const shown = view.value;
    if (failed.value) {
        return t(`workspace.fileRefPeek.failed`);
    }
    if (shown?.kind === `missing`) {
        return t(`workspace.fileRefPeek.notFound`);
    }
    if (shown?.kind === `empty`) {
        return t(`workspace.fileRefPeek.empty`);
    }
    if (shown?.kind === `binary`) {
        return t(`workspace.fileRefPeek.binary`);
    }
    if (shown?.kind === `beyond`) {
        return t(`workspace.fileRefPeek.beyond`, { line: shown.line.toLocaleString() });
    }
    return undefined;
});

// Colour for the rows, tokenized with the lines just above them so a comment or string opened there still reads as one.
// Plain text until it lands, and for a file with no grammar.
const { tokenizeLines } = useHighlighter();
const tokens = shallowRef<readonly (readonly CodeToken[])[]>();
const colouring = useLatest();
watch(
    view,
    (shown) => {
        const isLatest = colouring();
        tokens.value = undefined;
        const lang = shown?.kind === `lines` ? resolveFile(shown.path, undefined).lang : undefined;
        if (shown?.kind !== `lines` || lang === undefined) {
            return;
        }
        tokenizeLines([...shown.lead, ...shown.lines].join(`\n`), lang).then(
            (lines) => {
                if (isLatest()) {
                    tokens.value = lines?.slice(shown.lead.length);
                }
            },
            () => undefined,
        );
    },
    { immediate: true },
);

const rows = computed(() => {
    const shown = view.value;
    return shown?.kind === `lines`
        ? shown.lines.map((text, index) => ({ number: shown.first + index, text, tokens: tokens.value?.[index], marked: shown.first + index === shown.target }))
        : [];
});

// Placeholder rows while reading, the card's full height, so it does not jump as the lines land. Uneven, like code.
const PLACEHOLDER_WIDTHS = [58, 72, 44, 66, 30, 80, 52, 62, 38, 70, 48, 26];
const placeholders = PLACEHOLDER_WIDTHS.slice(0, PEEK_SPAN);
</script>

<template>
    <AnchoredOverlay v-model="open" :anchor="anchor" side="top" cross="start" :gap="6" :restore-focus="false">
        <!-- A pointer resting on the card holds it; a press on it opens the file, as the link would. -->
        <div
            data-peek-card
            class="flex min-h-0 w-[min(34rem,calc(100vw-2rem))] cursor-pointer flex-col text-left"
            @pointerenter="hover.cancel()"
            @pointerleave="onCardLeave"
            @click="openTarget"
        >
            <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
                <Icon :name="icon" class="shrink-0 text-sm" :class="iconColour" />
                <!-- The folder part gives way first, so the file's own name and line stay whole. -->
                <span class="flex min-w-0 flex-1 items-baseline font-mono text-2xs">
                    <span class="min-w-0 truncate text-subtle">{{ folder }}</span>
                    <span class="shrink-0 font-medium text-content">{{ name }}</span>
                    <span v-if="target?.line !== undefined" class="shrink-0 text-subtle">:{{ target.line }}</span>
                </span>
                <span v-if="aside !== undefined" class="shrink-0 text-2xs text-subtle tabular-nums">{{ aside }}</span>
            </div>

            <template v-if="view?.kind === 'lines' && !failed">
                <!-- One row per line, number and code side by side, so the marked line is one row's tint rather than a band laid over a block. Lines are cut, not wrapped or scrolled: a card the pointer passes through is glanced at, not read across. -->
                <div class="min-h-0 overflow-hidden bg-canvas py-1.5 font-mono text-2xs leading-relaxed [tab-size:4]">
                    <div
                        v-for="row in rows"
                        :key="row.number"
                        :data-peek-line="row.number"
                        :data-peek-marked="row.marked ? `` : undefined"
                        class="flex"
                        :class="row.marked ? `bg-primary-500/15 shadow-[inset_2px_0_0_var(--color-primary-500)]` : ``"
                    >
                        <span class="w-12 shrink-0 pr-3 text-right tabular-nums select-none" :class="row.marked ? `font-medium text-content` : `text-subtle`">{{
                            row.number
                        }}</span>
                        <span class="min-w-0 flex-1 overflow-hidden pr-3 text-ellipsis whitespace-pre text-content"
                            ><template v-if="row.tokens !== undefined"
                                ><span v-for="(token, at) in row.tokens" :key="at" class="file-peek-token" :style="token.htmlStyle">{{
                                    token.content
                                }}</span></template
                            ><template v-else>{{ row.text }}</template></span
                        >
                    </div>
                </div>
                <!-- A line after the file's end: its last lines are shown, and this says why the named one isn't marked. -->
                <p v-if="view.past && view.total !== undefined && target?.line !== undefined" class="border-t border-line px-3 py-1.5 text-2xs text-muted">
                    {{ t(`workspace.fileRefPeek.past`, { line: target.line.toLocaleString(), total: view.total.toLocaleString() }) }}
                </p>
            </template>
            <p v-else-if="note !== undefined" class="px-3 py-2.5 text-2xs text-muted">{{ note }}</p>
            <ul v-else-if="view?.kind === 'folder'" class="flex flex-col gap-0.5 px-2 py-2">
                <li v-for="child in view.names" :key="child" class="truncate px-1 text-xs text-content/80">{{ child }}</li>
                <li v-if="view.count > view.names.length" class="px-1 pt-1 text-2xs text-subtle">
                    {{ t(`workspace.fileRefPeek.more`, { count: (view.count - view.names.length).toLocaleString() }) }}
                </li>
            </ul>
            <!-- Reading: still placeholder rows in the code's own measure (no animation), so the card keeps its height. -->
            <div v-else class="bg-canvas py-1.5 font-mono text-2xs leading-relaxed" aria-hidden="true">
                <div v-for="(width, index) in placeholders" :key="index" class="flex items-center">
                    <span class="w-12 shrink-0">&nbsp;</span>
                    <span class="skeleton h-2" :style="{ width: `${width}%` }"></span>
                </div>
            </div>
        </div>
    </AnchoredOverlay>
</template>

<style scoped>
/* Shiki inlines the light colour and a `--shiki-dark` var on each token; dark mode swaps to the latter (as RuleCommand
   and ChatCommandBlock do). An ancestor attribute, which no class on the span can say. */
[data-mode="dark"] .file-peek-token {
    color: var(--shiki-dark) !important;
}
</style>
