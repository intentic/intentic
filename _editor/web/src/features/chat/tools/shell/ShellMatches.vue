<script setup lang="ts">
import { codeLangForPath } from "@intentic/code-read";
import { type CodeToken, useHighlighter } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { useT } from "@intentic/ui/i18n";
import ChatFoldClamp from "../../transcript/ChatFoldClamp.vue";
import ShellPathRow from "./ShellPathRow.vue";
import type { MatchHit, MatchMark, MatchesSection } from "./shellSearch";

// A search's hits under the file each is in, coloured in that file's language with what was searched for marked, the
// way the workspace's own search draws its results. A hit opens its file at its line.

const props = defineProps<{
    section: MatchesSection;
    openFile?: ((path: string, line?: number) => void) | undefined;
}>();

const t = useT();
const { tokenizeLine } = useHighlighter();

// Characters of one hit drawn; a minified line is not read in a chat.
const HIT_CHARS = 400;

// Indentation is structure, not content: a nested hit reads as dense as a top-level one.
const shown = (hit: MatchHit): string => hit.text.trimStart().slice(0, HIT_CHARS);

interface Span {
    readonly start: number;
    readonly end: number;
}

const spansOf = (text: string, mark: MatchMark | undefined): Span[] => {
    if (mark === undefined) {
        return [];
    }
    return [...text.matchAll(new RegExp(mark.source, mark.flags.includes(`g`) ? mark.flags : `${mark.flags}g`))]
        .filter((match) => match[0] !== ``)
        .map((match) => ({ start: match.index, end: match.index + match[0].length }));
};

// One run of a hit that is uniform in both rulers: the same colour token, the same side of a match.
interface Piece {
    readonly text: string;
    readonly style: CodeToken[`htmlStyle`];
    readonly hit: boolean;
}

// Cuts a hit at every colour boundary and every match edge; with no colour yet, at the match edges alone.
const piecesOf = (text: string, spans: readonly Span[], tokens: readonly CodeToken[] | undefined): Piece[] => {
    const pieces: Piece[] = [];
    for (const token of tokens ?? [{ content: text, offset: 0, htmlStyle: undefined }]) {
        const to = token.offset + token.content.length;
        let at = token.offset;
        for (const span of spans.filter((candidate) => candidate.end > at && candidate.start < to)) {
            const from = Math.max(at, span.start);
            if (from > at) {
                pieces.push({ text: text.slice(at, from), style: token.htmlStyle, hit: false });
            }
            at = Math.min(to, span.end);
            pieces.push({ text: text.slice(from, at), style: token.htmlStyle, hit: true });
        }
        if (to > at) {
            pieces.push({ text: text.slice(at, to), style: token.htmlStyle, hit: false });
        }
    }
    return pieces;
};

// Colour lands after the first draw, one hit at a time: `path:index` → that hit's tokens.
const colours = ref(new Map<string, readonly CodeToken[]>());
watch(
    () => props.section,
    (section) => {
        colours.value = new Map();
        for (const file of section.files) {
            const lang = codeLangForPath(file.path);
            if (lang === undefined) {
                continue;
            }
            file.hits.forEach((hit, index) => {
                void tokenizeLine(shown(hit), lang).then((tokens) => {
                    if (tokens !== undefined && props.section === section) {
                        colours.value = new Map(colours.value).set(`${file.path}:${index}`, tokens);
                    }
                });
            });
        }
    },
    { immediate: true },
);

const files = computed(() =>
    props.section.files.map((file) => {
        const hits = file.hits.map((hit, index) => {
            const text = shown(hit);
            return { hit, pieces: piecesOf(text, spansOf(text, props.section.mark), colours.value.get(`${file.path}:${index}`)) };
        });
        const count = file.hits.filter((hit) => !hit.context).length;
        return { file, hits, meta: t(`chat.toolPresentation.matches`, { count }, count) };
    }),
);

const lineCount = computed(() => files.value.reduce((sum, entry) => sum + 1 + entry.hits.length, 0));
</script>

<template>
    <ChatFoldClamp :lines="lineCount">
        <div class="flex min-w-max flex-col pb-1">
            <template v-for="(entry, order) in files" :key="entry.file.path">
                <ShellPathRow
                    :path="entry.file.path"
                    :meta="entry.meta"
                    :openable="openFile !== undefined"
                    :class="{ 'mt-1': order > 0 }"
                    @open="openFile?.(entry.file.open)"
                />
                <component
                    :is="openFile ? 'button' : 'div'"
                    v-for="(drawn, index) in entry.hits"
                    :key="index"
                    :type="openFile ? 'button' : undefined"
                    class="flex gap-2 pr-2.5 text-left font-mono"
                    :class="[drawn.hit.context ? 'opacity-60' : '', openFile ? 'transition-colors hover:bg-overlay' : '']"
                    @click="openFile?.(entry.file.open, drawn.hit.line)"
                >
                    <span class="w-10 shrink-0 text-right text-subtle tabular-nums">{{ drawn.hit.line }}</span>
                    <span class="whitespace-pre text-content"
                        ><template v-for="(piece, at) in drawn.pieces" :key="at"
                            ><mark v-if="piece.hit" class="rounded-sm bg-primary-500/25 text-inherit" :style="piece.style">{{ piece.text }}</mark
                            ><span v-else :style="piece.style">{{ piece.text }}</span></template
                        ></span
                    >
                </component>
            </template>
        </div>
    </ChatFoldClamp>
</template>
