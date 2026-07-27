<script setup lang="ts">
import type { IconName } from "@intentic-app/ui";
import { computed, ref } from "vue";
import type { ChatTool } from "../composables/chat/transcript";
import { openWorkspaceRef } from "../composables/workspace/openFileRef";
import ChatCodeBody from "./ChatCodeBody.vue";
import ChatToolDiff from "./ChatToolDiff.vue";
import { present } from "./toolPresentation";

/* One tool call in an assistant turn. All per-tool knowledge — icon, result summary, how the output is
 * shaped, whether the card starts open — comes from the presentation registry (toolPresentation.ts); this
 * component only renders what it returns and owns the interaction (fold, open-in-workspace). Adding a tool to
 * the taxonomy is a table entry there, never a branch here. File locations are clickable and open in the
 * workspace at the reported line (QuickOpen's navigation pattern, so it works from the shell-docked chat on
 * any view). */

const props = defineProps<{
    tool: ChatTool;
    // Whether the turn this card belongs to is still streaming — the only state in which the card may animate.
    live: boolean;
}>();

const view = computed(() => present(props.tool));
const running = computed(() => props.tool.status === `pending` || props.tool.status === `in_progress`);
const failed = computed(() => props.tool.status === `failed`);

// A call that never reported back: a Stop cut the turn off mid-flight, the stream dropped, or the session was
// restored from a file whose tool_use block has no matching result (see readWorkspaceSession). `in_progress` is
// the honest record of that, but it is FROZEN — nothing is going to move it — so the card must not keep
// spinning, which is a claim about right now rather than about what happened.
const unfinished = computed(() => running.value && !props.live);

// The header glyph: the loading spinner only while the call is genuinely in flight, a clock once it was left
// unfinished, and otherwise the registry's icon for the tool.
const statusIcon = computed<{ name: IconName; spin: boolean; class: string }>(() => {
    if (running.value && props.live) {
        return { name: `spinner`, spin: true, class: `text-link` };
    }
    if (unfinished.value) {
        return { name: `clock`, spin: false, class: `text-subtle` };
    }
    return { name: view.value.icon, spin: false, class: failed.value ? `text-danger` : `text-link` };
});

// Whether there's anything to fold — an output-less call (a pending tool, or a command that printed nothing)
// shows just its header, no chevron. A sub-agent card folds over its nested transcript (children + thinking)
// too, so the whole delegation collapses to one line once it settles.
const hasContent = computed(
    () => view.value.diffs.length > 0 || view.value.body !== undefined || props.tool.thinking !== undefined || (props.tool.children?.length ?? 0) > 0,
);

// Output fold, mirroring the turn's Thinking block. The registry decides the default (open while running or
// on failure); a manual toggle overrides it and sticks for the session.
const outputOverride = ref<boolean>();
const isOpen = computed(() => outputOverride.value ?? view.value.defaultOpen);
const toggleOpen = (): void => {
    outputOverride.value = !isOpen.value;
};

// The card's clickable location chip: the first workspace file this call touches.
const location = computed(() => props.tool.locations?.[0]);
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
                <Icon v-bind="statusIcon" class="text-2xs" />
                <span class="font-medium" :class="failed ? 'text-danger' : 'text-muted'">{{ tool.name }}</span>
            </button>
            <template v-else>
                <Icon v-bind="statusIcon" class="text-2xs" />
                <span class="font-medium" :class="failed ? 'text-danger' : 'text-muted'">{{ tool.name }}</span>
            </template>
            <button
                v-if="location"
                type="button"
                class="truncate font-mono transition-colors hover:text-content hover:underline"
                v-tooltip.top="'Open in workspace'"
                @click="openWorkspaceRef(location.path, location.line)"
            >
                {{ tool.target ?? location.path }}
            </button>
            <span v-else-if="tool.target" class="truncate font-mono">{{ tool.target }}</span>
            <!-- The result phrase stays visible while collapsed — a folded card should still say what
                 happened. Pushed right so it reads as a trailing annotation, not part of the target. A call
                 that never reported back says so, which is what the clock in its place means. -->
            <span v-if="unfinished" class="ml-auto shrink-0 text-subtle">interrupted</span>
            <span v-else-if="view.summary" class="ml-auto shrink-0 tabular-nums" :class="failed ? 'text-danger' : 'text-subtle'">{{
                view.summary
            }}</span>
        </div>
        <template v-if="isOpen">
            <!-- A sub-agent's own thinking, grouped onto its card as a muted inner-voice block rather than
                 merged into the parent turn's thinking (see conversation.ts). -->
            <pre
                v-if="tool.thinking"
                class="scrollbar-thin ml-4 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-canvas px-2 py-1 text-2xs italic leading-relaxed text-subtle"
                >{{ tool.thinking }}</pre>
            <!-- A sub-agent's nested transcript: the tool calls it made, indented under the delegation card so
                 the whole Agent run reads as one unit. Recursive — a sub-agent that itself delegates nests one
                 level deeper (ChatToolCard renders itself). -->
            <div v-if="tool.children?.length" class="ml-4 flex flex-col gap-1 border-l border-line pl-2">
                <ChatToolCard v-for="child in tool.children" :key="child.id" :tool="child" :live="live" />
            </div>
            <ChatToolDiff
                v-for="diff in view.diffs"
                :key="diff.path"
                :path="diff.path"
                :old-text="diff.oldText"
                :new-text="diff.newText"
                :truncated="diff.truncated"
                @open="openWorkspaceRef(diff.path)"
            />
            <!-- Three body shapes, chosen by the registry. `command` renders the invocation above its output
                 so a Bash card reads like a terminal; `files` turns a path listing into rows that navigate. -->
            <div v-if="view.body?.kind === 'command'" class="ml-4 overflow-hidden rounded border border-line bg-canvas">
                <div v-if="view.body.command" class="flex gap-1.5 border-b border-line px-2 py-1 font-mono text-2xs text-muted">
                    <span class="shrink-0 select-none text-subtle">$</span>
                    <span class="whitespace-pre-wrap break-all">{{ view.body.command }}</span>
                </div>
                <pre
                    v-if="view.body.output"
                    class="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap px-2 py-1 text-2xs leading-relaxed"
                    :class="failed ? 'text-danger' : 'text-muted'"
                    >{{ view.body.output }}</pre>
            </div>
            <div
                v-else-if="view.body?.kind === 'files'"
                class="scrollbar-thin ml-4 flex max-h-40 flex-col overflow-auto rounded border border-line bg-canvas px-1 py-1"
            >
                <button
                    v-for="(entry, index) in view.body.entries"
                    :key="`${entry.path}:${entry.line ?? ''}:${index}`"
                    type="button"
                    class="flex items-baseline gap-1.5 rounded px-1 py-0.5 text-left font-mono text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                    v-tooltip.top="'Open in workspace'"
                    @click="openWorkspaceRef(entry.path, entry.line)"
                >
                    <span class="truncate">{{ entry.path }}</span>
                    <span v-if="entry.line" class="shrink-0 text-subtle">:{{ entry.line }}</span>
                </button>
                <span v-if="view.body.hidden" class="px-1 py-0.5 text-2xs text-subtle">… {{ view.body.hidden }} more</span>
            </div>
            <!-- A Read's file contents: syntax-highlighted with a line-number gutter (toolPresentation shapes the
                 `code` body; ChatCodeBody colors it via the shared Shiki highlighter, like the workspace viewer). -->
            <ChatCodeBody v-else-if="view.body?.kind === 'code'" :code="view.body.code" :lang="view.body.lang" :first-line="view.body.firstLine" />
            <pre
                v-else-if="view.body"
                class="scrollbar-thin ml-4 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-canvas px-2 py-1 text-2xs leading-relaxed"
                :class="failed ? 'text-danger' : 'text-muted'"
                >{{ view.body.text }}</pre>
        </template>
    </div>
</template>
