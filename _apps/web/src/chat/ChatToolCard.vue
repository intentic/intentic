<script setup lang="ts">
import type { IconName } from "@intentic-app/ui";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import type { ChatTool } from "../composables/chat/conversation";
import { useWorkspaceTabs } from "../composables/workspace/useWorkspaceTabs";
import ChatToolDiff from "./ChatToolDiff.vue";

/* One tool call in an assistant turn: category icon, name, target, live status (spinner while running, red
 * tint on failure), structured diff content rendered inline, and text output in a capped scroll box. File
 * locations are clickable — they open the file in the workspace at the reported line (QuickOpen's
 * navigation pattern, so it works from the shell-docked chat on any view). */

const props = defineProps<{ tool: ChatTool }>();

const router = useRouter();
const { openFile, openAtLine } = useWorkspaceTabs();

const CATEGORY_ICONS: Record<ChatTool[`category`], IconName> = {
    read: `file`,
    edit: `file-edit`,
    delete: `trash`,
    move: `forward`,
    search: `search`,
    execute: `code`,
    think: `sparkles`,
    fetch: `globe`,
    other: `angle-right`,
};

const icon = computed<IconName>(() => CATEGORY_ICONS[props.tool.category]);
const running = computed(() => props.tool.status === `pending` || props.tool.status === `in_progress`);
const failed = computed(() => props.tool.status === `failed`);

const diffs = computed(() => (props.tool.content ?? []).filter((entry) => entry.type === `diff`));
const text = computed(() =>
    (props.tool.content ?? [])
        .filter((entry) => entry.type === `text`)
        .map((entry) => entry.text)
        .join(``),
);

// Cap the text output so a large file read / chatty command can't bloat the DOM (the box scrolls anyway).
// ponytail: 4k-char cap, raise it if real outputs get clipped.
const cappedText = computed(() => (text.value.length > 4000 ? `${text.value.slice(0, 4000)}\n… (truncated)` : text.value));

// Whether there's anything to fold — an output-less call (a pending tool, or a command that printed
// nothing) shows just its header, no chevron.
const hasContent = computed(() => diffs.value.length > 0 || cappedText.value.length > 0);

// Output fold, mirroring the turn's Thinking block: expanded while the call runs (so live output is
// visible), collapsed once it settles. A manual toggle overrides and sticks for the session.
const outputOverride = ref<boolean>();
const isOpen = computed(() => outputOverride.value ?? running.value);
const toggleOpen = (): void => {
    outputOverride.value = !isOpen.value;
};

// The card's clickable location chip: the first workspace file this call touches.
const location = computed(() => props.tool.locations?.[0]);

const open = (path: string, line?: number): void => {
    if (line !== undefined) {
        openAtLine(path, line);
    } else {
        openFile(path);
    }
    // Bring the workspace into view (no-op when already there — the route watchers' equality guards hold).
    void router.push({ name: `workspace`, params: { path: path.split(`/`) } });
};
</script>

<template>
    <div class="flex flex-col gap-0.5">
        <div class="flex items-center gap-1.5 text-2xs text-subtle">
            <!-- Header doubles as the fold toggle when there's output — same chevron affordance as the
                 turn's Thinking block. Output-less calls keep a plain, non-clickable header. -->
            <button
                v-if="hasContent"
                type="button"
                class="flex shrink-0 items-center gap-1.5 transition-colors hover:text-content"
                :aria-expanded="isOpen"
                @click="toggleOpen"
            >
                <Icon :name="isOpen ? 'chevron-down' : 'chevron-right'" class="text-2xs" />
                <Icon v-if="running" name="spinner" class="text-2xs text-link" spin />
                <Icon v-else :name="icon" class="text-2xs" :class="failed ? 'text-danger' : 'text-link'" />
                <span class="font-medium" :class="failed ? 'text-danger' : 'text-muted'">{{ tool.name }}</span>
            </button>
            <template v-else>
                <Icon v-if="running" name="spinner" class="text-2xs text-link" spin />
                <Icon v-else :name="icon" class="text-2xs" :class="failed ? 'text-danger' : 'text-link'" />
                <span class="font-medium" :class="failed ? 'text-danger' : 'text-muted'">{{ tool.name }}</span>
            </template>
            <button
                v-if="location"
                type="button"
                class="truncate font-mono transition-colors hover:text-content hover:underline"
                v-tooltip.top="'Open in workspace'"
                @click="open(location.path, location.line)"
            >
                {{ tool.target ?? location.path }}
            </button>
            <span v-else-if="tool.target" class="truncate font-mono">{{ tool.target }}</span>
        </div>
        <template v-if="isOpen">
            <ChatToolDiff
                v-for="diff in diffs"
                :key="diff.path"
                :path="diff.path"
                :old-text="diff.oldText"
                :new-text="diff.newText"
                :truncated="diff.truncated"
                @open="open(diff.path)"
            />
            <pre
                v-if="cappedText"
                class="scrollbar-thin ml-4 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-canvas px-2 py-1 text-2xs leading-relaxed"
                :class="failed ? 'text-danger' : 'text-muted'"
                >{{ cappedText }}</pre>
        </template>
    </div>
</template>
