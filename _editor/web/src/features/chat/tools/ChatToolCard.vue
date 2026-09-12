<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { computed, ref } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import { useChatSurface } from "./chatToolSurface";
import ChatCodeBody from "../transcript/ChatCodeBody.vue";
import ChatDocumentBody from "../transcript/ChatDocumentBody.vue";
import ChatToolDiff from "./ChatToolDiff.vue";
import { present } from "./toolPresentation";

// One tool call: per-tool facts (icon, summary, output shape, default-open) come from the presentation
// registry (toolPresentation.ts); this component renders them and owns fold/open-in-workspace. Everything that
// leaves the card comes from the injected surface (chatToolSurface.ts), so a published conversation with no
// surface has nothing to click.

const props = defineProps<{
    tool: TranscriptTool;
    // Whether the turn this card belongs to is still streaming: the only state in which the card may animate.
    live: boolean;
}>();

const view = computed(() => present(props.tool));
const running = computed(() => props.tool.status === `pending` || props.tool.status === `in_progress`);
const failed = computed(() => props.tool.status === `failed`);

// A call that never reported back reads `in_progress` but is frozen; it must not keep spinning.
const unfinished = computed(() => running.value && !props.live);

// Header glyph: the spinner only while genuinely in flight, a clock once left unfinished, else the registry's
// icon for the tool.
const statusIcon = computed<{ name: IconName; spin: boolean; class: string }>(() => {
    if (running.value && props.live) {
        return { name: `spinner`, spin: true, class: `text-link` };
    }
    if (unfinished.value) {
        return { name: `clock`, spin: false, class: `text-subtle` };
    }
    return { name: view.value.icon, spin: false, class: failed.value ? `text-danger` : `text-link` };
});

// Whether there's anything to fold: an output-less call shows just its header. A sub-agent also folds its
// nested transcript (children + thinking), collapsing the whole delegation to one line once settled.
const hasContent = computed(
    () =>
        view.value.document !== undefined ||
        view.value.diffs.length > 0 ||
        view.value.images.length > 0 ||
        view.value.body !== undefined ||
        props.tool.thinking !== undefined ||
        (props.tool.children?.length ?? 0) > 0 ||
        // A backgrounded child's report is the only content under its card until the result lands.
        props.tool.subagent?.summary !== undefined,
);

// Output fold, mirroring the turn's Thinking block: the registry picks the default (open while running or
// failed); a manual toggle overrides it for the session.
const outputOverride = ref<boolean>();
const isOpen = computed(() => outputOverride.value ?? view.value.defaultOpen);
const toggleOpen = (): void => {
    outputOverride.value = !isOpen.value;
};

// The card's clickable location chip: the first workspace file this call touches.
const location = computed(() => props.tool.locations?.[0]);

// Everything this card can lead to, from whoever is showing it. In the app, each card offers its own chat's
// shell/browser; on a published conversation, nothing.
const surface = useChatSurface();
const openFile = surface.openFile;

// The shell behind a command card: an agent's Bash runs in a real tmux session, no longer tabbed into the
// strip, so this is where watching (and asking "what's it doing") happens. Only for command-shaped cards with
// a recorded shell.
const agentTerminal = computed(() => (view.value.body?.kind === `command` ? surface.commandTerminal?.() : undefined));

// The browser behind a browser card, through a different door: jumps to the Browsers area with that session
// selected. Every browser tool gets it, since a click or fill is worth watching even without a returned picture.
const agentBrowser = computed(() => (props.tool.name.toLowerCase().startsWith(`browser `) ? surface.commandBrowser?.() : undefined));

// The agent this call started; the card's own id is the subagent's id in the registry. Shows progress and
// spend while it runs, its conclusion once it stops — the only signal a backgrounded child has.
const subagent = computed(() => props.tool.subagent);
const subagentLive = computed(
    () => subagent.value?.status === `running` || subagent.value?.status === `pending` || subagent.value?.status === `blocked`,
);
// The row above the fold, in reading order: what type it runs as, then what it was asked to do.
const subagentTitle = computed(() => [subagent.value?.agentType, subagent.value?.description].filter(Boolean).join(` · `));
// The quiet numbers line: tokens are the child's own spend, worth stating since the parent's cost readout
// doesn't include them yet.
const subagentFacts = computed<string[]>(() => {
    const child = subagent.value;
    if (child === undefined) {
        return [];
    }
    return [
        ...(subagentLive.value && child.lastTool !== undefined ? [child.lastTool] : []),
        ...(child.toolUses !== undefined && child.toolUses > 0 ? [`${child.toolUses} tools`] : []),
        ...(child.tokens !== undefined && child.tokens > 0 ? [`${Math.round(child.tokens / 1000)}k tokens`] : []),
    ];
});

// Behaves like any in-app link: a plain click is routed, a modified one (new tab/window) is left to the
// browser, and a surface with no router just lets the anchor load. Hand-written rather than RouterLink (see
// chatToolSurface.ts).
const openSubagent = (event: MouseEvent, toolId: string): void => {
    const route = surface.subagentRoute?.(toolId);
    // Already answered: a popped-out window routes every in-app link to the app's own window first.
    if (event.defaultPrevented || route === undefined || surface.navigate === undefined) {
        return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
    }
    event.preventDefault();
    surface.navigate(route);
};
</script>

<template>
    <div class="flex flex-col gap-0.5">
        <!--
            Muted, not subtle: the target (a path, a command) is the one thing a folded card still says, and subtle sits
            too close to the surface to read at a glance.
        -->
        <div class="group/tool flex min-w-0 items-center gap-1.5 text-2xs text-muted">
            <!--
                Header doubles as the fold toggle when there's output, same chevron as the turn's Thinking block; an
                output-less call keeps a plain header.
            -->
            <button
                v-if="hasContent"
                type="button"
                class="flex shrink-0 items-center gap-1.5 whitespace-nowrap transition-colors hover:text-content"
                :aria-expanded="isOpen"
                @click="toggleOpen"
            >
                <Icon :name="isOpen ? 'chevron-down' : 'chevron-right'" class="text-2xs" />
                <Icon v-bind="statusIcon" class="text-2xs" />
                <span class="font-medium" :class="failed ? 'text-danger' : 'text-muted'">{{ tool.name }}</span>
            </button>
            <template v-else>
                <!--
                    Kept as one protected flex item too: chat messages inherit `overflow-wrap: anywhere`, and without this a
                    long target would shrink the name to a character per line.
                -->
                <span class="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                    <Icon v-bind="statusIcon" class="text-2xs" />
                    <span class="font-medium" :class="failed ? 'text-danger' : 'text-muted'">{{ tool.name }}</span>
                </span>
            </template>
            <!-- Who it delegated to and what it asked for, in the slot a path would take; a sentence, not mono. -->
            <span v-if="subagentTitle" class="min-w-0 truncate">{{ subagentTitle }}</span>
            <!--
                A document takes the same slot: its title is what the reader wants, while its path is a generated or
                unbrowsed name (a click away in the document's own header).
            -->
            <span v-else-if="view.document" class="min-w-0 truncate">{{ view.document.title }}</span>
            <!-- Clickable only where there's a workspace to open it in; published to the public it's plain text. -->
            <button
                v-else-if="location && openFile"
                type="button"
                class="min-w-0 truncate font-mono transition-colors hover:text-content hover:underline"
                v-tooltip.top="'Open in workspace'"
                @click="openFile(location.path, location.line)"
            >
                {{ tool.target ?? location.path }}
            </button>
            <span v-else-if="location || tool.target" class="min-w-0 truncate font-mono">{{ tool.target ?? location?.path }}</span>
            <!-- Working in the background while the parent moved on: why this card can sit unfinished for minutes. -->
            <span v-if="subagent?.background === true && subagentLive" class="ui-status-pill shrink-0 bg-overlay text-2xs text-subtle"
                >background</span
            >
            <!--
                The delegate itself reports being stuck on a permission or question; the one live state worth shouting,
                since the terminal button beside it is where to answer it.
            -->
            <span v-if="subagent?.status === `blocked`" class="ui-status-pill shrink-0 bg-overlay text-2xs text-warning">needs input</span>
            <!--
                The result phrase stays visible while collapsed, pushed right as a trailing annotation; a call that never
                reported back says so via the clock in its place.
            -->
            <!--
                What the child is doing and has spent, since its own result summary can't report the thing it's still
                waiting on. Trailing slot while live, handed back to the ordinary summary once settled.
            -->
            <span v-if="subagentFacts.length > 0 && subagentLive" class="ml-auto flex shrink-0 items-center gap-2 tabular-nums text-subtle">
                <span v-for="fact in subagentFacts" :key="fact">{{ fact }}</span>
            </span>
            <span v-else-if="unfinished" class="ml-auto shrink-0 text-subtle">interrupted</span>
            <span v-else-if="view.summary" class="ml-auto shrink-0 tabular-nums" :class="failed ? 'text-danger' : 'text-subtle'">{{
                view.summary
            }}</span>
            <!--
                Attach to the command's shell while it's genuinely in flight ("what's it doing right now"), hover-only once
                settled so a quiet transcript stays quiet.
            -->
            <button
                v-if="agentTerminal && surface.watchTerminal"
                type="button"
                class="shrink-0 transition-opacity hover:text-content"
                :class="[running && live ? '' : 'opacity-0 group-hover/tool:opacity-100', { 'ml-auto': !unfinished && !view.summary }]"
                v-tooltip.top="'Watch in terminal'"
                aria-label="Watch in terminal"
                @click="surface.watchTerminal(agentTerminal)"
            >
                <Icon name="desktop" class="text-2xs" />
            </button>
            <!-- The same door, onto the live page instead of the live shell. -->
            <button
                v-if="agentBrowser && surface.watchBrowser"
                type="button"
                class="shrink-0 transition-opacity hover:text-content"
                :class="[running && live ? '' : 'opacity-0 group-hover/tool:opacity-100', { 'ml-auto': !unfinished && !view.summary }]"
                v-tooltip.top="'Watch the browser'"
                aria-label="Watch the browser"
                @click="surface.watchBrowser(agentBrowser)"
            >
                <Icon name="globe" class="text-2xs" />
            </button>
            <!--
                The third door: the child's own transcript. Unlike the two above, not hover-only once settled — a finished
                delegation's transcript is exactly what someone scrolling back wants.
            -->
            <a
                v-if="subagent && surface.subagentRoute"
                :href="surface.subagentRoute(tool.id)"
                class="shrink-0 transition-colors hover:text-content"
                v-tooltip.top="subagentLive ? 'Watch this agent' : `Open this agent's transcript`"
                :aria-label="subagentLive ? 'Watch this agent' : `Open this agent's transcript`"
                @click="openSubagent($event, tool.id)"
            >
                <Icon name="users" class="text-2xs" />
            </a>
        </div>
        <template v-if="isOpen">
            <!--
                What the child concluded (its own last words, or the tail of what it printed), shown above the nested calls
                since the answer matters more than the work behind it. The only report a backgrounded child has before its
                result lands.
            -->
            <p
                v-if="subagent?.summary"
                class="ml-4 whitespace-pre-wrap rounded border border-line bg-canvas px-2 py-1 text-2xs leading-relaxed"
                :class="subagent.error ? 'text-danger' : 'text-muted'"
            >
                {{ subagent.summary }}
            </p>
            <!-- A sub-agent's own thinking, grouped on its card rather than merged into the parent turn's. -->
            <pre
                v-if="tool.thinking"
                class="scrollbar-thin ml-4 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-canvas px-2 py-1 text-2xs italic leading-relaxed text-subtle"
                >{{ tool.thinking }}</pre>
            <!--
                A sub-agent's nested transcript, indented under the delegation so the whole run reads as one unit; recursive,
                since a delegating sub-agent nests one level deeper.
            -->
            <div v-if="tool.children?.length" class="ml-4 flex flex-col gap-1 border-l border-line pl-2">
                <ChatToolCard v-for="child in tool.children" :key="child.id" :tool="child" :live="live" />
            </div>
            <!--
                What the agent produced or looked at; the surface decides where the bytes come from (re-minted from the
                workspace in-app, a copy alongside a published page with nothing to open).
            -->
            <component
                :is="openFile ? 'button' : 'div'"
                v-for="image in view.images"
                :key="image.path"
                :type="openFile ? 'button' : undefined"
                class="ml-4 overflow-hidden rounded border border-line bg-canvas text-left"
                v-tooltip.top="openFile ? 'Open in workspace' : undefined"
                @click="openFile?.(image.path)"
            >
                <img
                    v-if="surface.imageUrl(image.path)"
                    :src="surface.imageUrl(image.path)"
                    :alt="image.path"
                    class="max-h-80 w-full object-contain"
                />
                <span v-else class="block px-2 py-1 font-mono text-2xs text-subtle">{{ image.path }}</span>
            </component>
            <!--
                What the call wrote for the reader, above the machine-facing halves: a whole markdown file is drawn as
                prose, not as the diff it arrived as.
            -->
            <ChatDocumentBody v-if="view.document" :document="view.document" :titled="false" max-height="32rem" class="ml-4" />
            <ChatToolDiff
                v-for="diff in view.diffs"
                :key="diff.path"
                :path="diff.path"
                :old-text="diff.oldText"
                :new-text="diff.newText"
                :truncated="diff.truncated"
                :openable="openFile !== undefined"
                @open="openFile?.(diff.path)"
            />
            <!--
                Body shape chosen by the registry: `command` shows the invocation above its output like a terminal; `files`
                turns a path listing into navigable rows.
            -->
            <div v-if="view.body?.kind === 'command'" class="ml-4 overflow-hidden rounded border border-line bg-canvas">
                <div v-if="view.body.command" class="flex gap-1.5 border-b border-line px-2 py-1 font-mono text-2xs text-muted">
                    <span class="shrink-0 select-none text-subtle">$</span>
                    <span class="whitespace-pre-wrap">{{ view.body.command }}</span>
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
                <component
                    :is="openFile ? 'button' : 'div'"
                    v-for="(entry, index) in view.body.entries"
                    :key="`${entry.path}:${entry.line ?? ''}:${index}`"
                    :type="openFile ? 'button' : undefined"
                    class="flex items-baseline gap-1.5 rounded px-1 py-0.5 text-left font-mono text-2xs text-muted transition-colors"
                    :class="openFile && 'hover:bg-overlay hover:text-content'"
                    v-tooltip.top="openFile ? 'Open in workspace' : undefined"
                    @click="openFile?.(entry.path, entry.line)"
                >
                    <span class="truncate">{{ entry.path }}</span>
                    <span v-if="entry.line" class="shrink-0 text-subtle">:{{ entry.line }}</span>
                </component>
                <span v-if="view.body.hidden" class="px-1 py-0.5 text-2xs text-subtle">… {{ view.body.hidden }} more</span>
            </div>
            <!-- A Read's contents: syntax-highlighted with a line-number gutter, the same highlighter as the workspace viewer. -->
            <ChatCodeBody v-else-if="view.body?.kind === 'code'" :code="view.body.code" :lang="view.body.lang" :first-line="view.body.firstLine" />
            <pre
                v-else-if="view.body"
                class="scrollbar-thin ml-4 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-canvas px-2 py-1 text-2xs leading-relaxed"
                :class="failed ? 'text-danger' : 'text-muted'"
                >{{ view.body.text }}</pre>
        </template>
    </div>
</template>
