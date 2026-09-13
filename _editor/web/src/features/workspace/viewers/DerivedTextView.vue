<script setup lang="ts">
import { Button, CopyButton, formatTokens, Markdown, timeAgo } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { ref, watch } from "vue";
import { changeEpochOf } from "../changes/useWorkspaceLive";
import { deriveText, readDerivedText, type WorkspaceDerived } from "../files/derivedText";

/* A file's derived text: what the sandbox rendered a document, picture, recording or archive into, which is the
 * same text an agent reads instead of the bytes. Two jobs in one surface — it is the only preview a zip or an
 * EPUB has, and it is where anyone can check what an agent is working from, which is why the provenance (which
 * reader, when, what it had to cut, whether the file has moved on since) rides above the prose rather than
 * hiding behind it. */

// `downloadable`: the parent can hand over the bytes, so the empty state and the band can offer that too.
const { path, downloadable = false } = defineProps<{ path: string; downloadable?: boolean }>();
const emit = defineEmits<{ download: [] }>();

const shadow = ref<WorkspaceDerived | undefined>(undefined);
const loading = ref(false);
// Split from `loading`: one is the file opening, the other is work this reader asked for and is waiting on.
const deriving = ref(false);
const error = ref<string | null>(null);

// Reads are cheap and idempotent; a stale one landing after a newer one is the only hazard, so the sequence wins.
let seq = 0;
const settle = (id: number, result: WorkspaceDerived): void => {
    if (id !== seq) {
        return;
    }
    shadow.value = result;
    error.value = null;
};

const load = (target: string): void => {
    const id = ++seq;
    loading.value = true;
    readDerivedText(target).then(
        (result) => {
            settle(id, result);
            loading.value = false;
        },
        (err: unknown) => {
            if (id !== seq) {
                return;
            }
            loading.value = false;
            error.value = errorMessage(err, `Could not read this file's text.`);
        },
    );
};

// Re-read when the file itself changes: whether the text still matches is the one fact this surface cannot cache.
watch(
    () => [path, changeEpochOf(path)] as const,
    ([target]) => load(target),
    { immediate: true },
);

const derive = (): void => {
    const id = ++seq;
    deriving.value = true;
    deriveText(path).then(
        (result) => {
            settle(id, result);
            deriving.value = false;
        },
        (err: unknown) => {
            if (id !== seq) {
                return;
            }
            deriving.value = false;
            error.value = errorMessage(err, `Could not render this file as text.`);
        },
    );
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <template v-if="shadow?.present === true">
            <!-- Provenance first: what made this text, how much of an agent's context it costs, and how old it is. -->
            <div class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1.5 text-2xs text-muted">
                <Icon name="robot" class="shrink-0 text-[0.7rem]" />
                <span class="shrink-0" v-tooltip.bottom="'Not the file itself: the text this sandbox rendered from it, and what an agent reads here instead of the bytes.'">
                    Derived text
                </span>
                <span class="shrink-0 text-subtle">{{ shadow.deriver }}</span>
                <span class="shrink-0 text-subtle">{{ formatTokens(shadow.tokens) }} tokens</span>
                <span v-if="shadow.derivedAt !== undefined" class="shrink-0 text-subtle">{{ timeAgo(Date.parse(shadow.derivedAt), { days: true }) }}</span>
                <span class="flex-1"></span>
                <CopyButton :text="shadow.content" aria-label="Copy derived text" v-tooltip.bottom="'Copy this text'" />
                <Button
                    size="small"
                    severity="secondary"
                    :text="true"
                    class="shrink-0"
                    :disabled="deriving"
                    @click="derive"
                    v-tooltip.bottom="'Read the file again and rewrite this text'"
                >
                    <Icon :name="deriving ? `spinner` : `refresh`" :spin="deriving" class="text-[0.7rem]" /> Derive again
                </Button>
                <Button v-if="downloadable" size="small" severity="secondary" :text="true" class="shrink-0" @click="emit(`download`)">
                    <Icon name="download" class="text-[0.7rem]" /> Download
                </Button>
            </div>
            <!-- The file moved on under its text. Said plainly, since everything below is then about an older file. -->
            <div v-if="shadow.stale" class="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-2xs text-warning">
                <Icon name="exclamation-triangle" class="shrink-0 text-[0.7rem]" />
                <span>This file changed after its text was made, so this is a reading of an older version.</span>
            </div>
            <!--
                Every cap and degradation the derivation hit, shown rather than stored: text that was cut reading as the
                whole document is the one failure this surface cannot afford.
            -->
            <ul v-if="shadow.notes.length > 0" class="shrink-0 space-y-0.5 border-b border-line bg-overlay px-3 py-1.5 text-2xs text-muted">
                <li v-for="note of shadow.notes" :key="note" class="flex items-start gap-2">
                    <Icon name="info-circle" class="mt-px shrink-0 text-[0.7rem]" />
                    <span>{{ note }}</span>
                </li>
            </ul>
            <div class="ui-softscroll min-h-0 flex-1 overflow-auto bg-canvas px-6 py-5">
                <Markdown v-if="shadow.content !== ''" :source="shadow.content" class="mx-auto max-w-3xl" />
                <p v-else class="mx-auto max-w-3xl text-sm text-muted">
                    This file rendered to nothing at all. The notes above say what was read; the file itself may simply hold no text.
                </p>
                <p v-if="shadow.truncated" class="mx-auto mt-6 max-w-3xl border-t border-line pt-3 text-2xs text-subtle">
                    Long rendering: only its first part is shown here.
                </p>
            </div>
        </template>

        <div v-else-if="loading || deriving" class="flex h-full flex-col items-center justify-center gap-2 text-muted">
            <Icon name="spinner" class="text-xl" spin />
            <p v-if="deriving" class="text-2xs">Reading the file…</p>
        </div>

        <div v-else-if="error" class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Icon name="exclamation-triangle" class="text-3xl text-danger" />
            <p class="text-sm text-danger">{{ error }}</p>
        </div>

        <!-- No text yet. Which of the two reasons decides whether there is anything to offer. -->
        <div v-else class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Icon :name="shadow?.derivable === true ? `align-left` : `box`" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">
                {{
                    shadow?.derivable === true
                        ? `Nothing has read this file yet. Rendering it gives you its text — and gives an agent the same.`
                        : `Nothing here can turn this file into text.`
                }}
            </p>
            <p v-if="shadow?.reason !== undefined" class="max-w-sm text-2xs text-subtle">{{ shadow.reason }}</p>
            <div class="mt-1 flex items-center gap-2">
                <Button v-if="shadow?.derivable === true" severity="secondary" @click="derive">
                    <Icon name="align-left" class="text-xs" />
                    Render as text
                </Button>
                <Button v-if="downloadable" severity="secondary" @click="emit(`download`)">
                    <Icon name="download" class="text-xs" />
                    Download
                </Button>
            </div>
            <p v-if="shadow?.derivable === true" class="max-w-sm text-2xs text-subtle">
                Settings → Agent → Document shadows keeps every document, picture, recording and archive rendered as files change.
            </p>
        </div>
    </div>
</template>
