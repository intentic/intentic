<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { computed, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import type { ChatTool } from "../composables/chat/transcript";
import { usePaneView } from "../composables/chat/useChat";
import { attachmentPreview } from "../composables/chat/attachmentPreviews";
import { openWorkTerminal } from "../composables/terminal/useWorkTerminals";
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
    () =>
        view.value.diffs.length > 0 ||
        view.value.images.length > 0 ||
        view.value.body !== undefined ||
        props.tool.thinking !== undefined ||
        (props.tool.children?.length ?? 0) > 0 ||
        // A backgrounded child's report is the only thing under its card until its result lands, and a card with
        // nothing to open reads as a card with nothing to say.
        props.tool.subagent?.summary !== undefined,
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

/* The shell behind a command card. An agent's Bash runs in a real tmux session that the terminal panel can
 * attach to, but those sessions no longer tab themselves into the strip (useWorkTerminals) — so this card is
 * where watching one is offered, which is also where the question ("what is it actually doing?") gets asked.
 * Only command-shaped cards get it, and only while the conversation on screen has a shell recorded: the card
 * reads the conversation of the PANE it is in, so with two chats side by side each card offers its own. */
const { conversation } = usePaneView();
const agentTerminal = computed(() => (view.value.body?.kind === `command` ? conversation.value.agentTerminal.value : undefined));

/* The BROWSER behind a browser card, on the same terms but through a different door: its Chromium is not a
 * pane in the terminal panel but a surface of its own, so this jumps to the Browsers area with that session
 * already selected. Every browser tool gets the button, not just the ones that returned a picture — a click or
 * a form fill is precisely when watching is worth more than reading. */
const agentBrowser = computed(() => (props.tool.name.toLowerCase().startsWith(`browser `) ? conversation.value.agentBrowser.value : undefined));
// Whose copy of the workspace this card's paths name (workspaceScope) — the same answer the pane's prose
// gives, because a tool ran in the conversation's own checkout exactly as the prose describing it did.
const linkScope = computed(() => ({ agent: conversation.value.isolated.value ? conversation.value.conversationId : undefined }));
const router = useRouter();
const watchBrowser = (session: string): void => void router.push(`/browsers/${session}`);

/* THE AGENT THIS CALL STARTED — the third door of the same kind, onto the one thing a subagent has instead of a
 * process: its transcript. The card's own id IS the subagent's id in the registry (see ChatTool.subagent), so the
 * link needs nothing the card doesn't already hold.
 *
 * The line it wears is the answer to "is anything happening?", which for a BACKGROUNDED child is a question the
 * transcript could not answer at all before: its result may be minutes away, and a spinner over an empty card is
 * indistinguishable from a hang. So while it runs the card says what the child is doing and what it has spent,
 * and once it stops it says what it concluded. */
const subagent = computed(() => props.tool.subagent);
const subagentLive = computed(() => subagent.value?.status === `running` || subagent.value?.status === `pending`);
// What the row above the fold says, in the order it is read: the type it runs as, then what it was asked to do.
const subagentTitle = computed(() => [subagent.value?.agentType, subagent.value?.description].filter(Boolean).join(` · `));
// The quiet numbers line. Tokens are the CHILD's own spend, which is why they are worth saying next to a parent
// whose cost readout does not include them yet.
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
</script>

<template>
    <div class="flex flex-col gap-0.5">
        <!-- The row is muted, not subtle: the target it carries (a path, a command) is the one thing a folded
             card still says, and at the meta tier subtle sits too close to the surface to read at a glance. -->
        <div class="group/tool flex min-w-0 items-center gap-1.5 text-2xs text-muted">
            <!-- Header doubles as the fold toggle when there's output — same chevron affordance as the
                 turn's Thinking block. Output-less calls keep a plain, non-clickable header. -->
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
                <!-- Keep the output-less header as one protected flex item too. `overflow-wrap: anywhere` is
                     inherited by chat messages, so independent icon/name items let a long target shrink a
                     short name to one or two characters per line. The target is the intentionally elastic
                     part of this row. -->
                <span class="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                    <Icon v-bind="statusIcon" class="text-2xs" />
                    <span class="font-medium" :class="failed ? 'text-danger' : 'text-muted'">{{ tool.name }}</span>
                </span>
            </template>
            <!-- A delegation says WHO it handed the work to and WHAT it asked for, in the slot a path would take:
                 `Explore · Locate claimIndexer definition`. Not mono — this is a sentence, not an identifier. -->
            <span v-if="subagentTitle" class="min-w-0 truncate">{{ subagentTitle }}</span>
            <button
                v-else-if="location"
                type="button"
                class="min-w-0 truncate font-mono transition-colors hover:text-content hover:underline"
                v-tooltip.top="'Open in workspace'"
                @click="openWorkspaceRef(location.path, location.line, linkScope)"
            >
                {{ tool.target ?? location.path }}
            </button>
            <span v-else-if="tool.target" class="min-w-0 truncate font-mono">{{ tool.target }}</span>
            <!-- Working in the background while the parent went on. The one fact that explains why this card can
                 sit unfinished for minutes with the turn plainly still moving underneath it. -->
            <span v-if="subagent?.background === true && subagentLive" class="shrink-0 rounded-full bg-overlay px-1.5 py-px text-2xs text-subtle"
                >background</span
            >
            <!-- The result phrase stays visible while collapsed — a folded card should still say what
                 happened. Pushed right so it reads as a trailing annotation, not part of the target. A call
                 that never reported back says so, which is what the clock in its place means. -->
            <!-- What the CHILD is doing and what it has spent — a subagent's own progress, which its parent's
                 result summary cannot report because the result is the thing being waited for. Takes the trailing
                 slot while the child is live and gives it back to the ordinary summary once it settles. -->
            <span v-if="subagentFacts.length > 0 && subagentLive" class="ml-auto flex shrink-0 items-center gap-2 tabular-nums text-subtle">
                <span v-for="fact in subagentFacts" :key="fact">{{ fact }}</span>
            </span>
            <span v-else-if="unfinished" class="ml-auto shrink-0 text-subtle">interrupted</span>
            <span v-else-if="view.summary" class="ml-auto shrink-0 tabular-nums" :class="failed ? 'text-danger' : 'text-subtle'">{{
                view.summary
            }}</span>
            <!-- Attach to the shell this command runs in. Present while the call is genuinely in flight — that's
                 when "what is it doing right now?" is asked, and the answer is one click away — and hover-only
                 afterwards, so a settled transcript stays as quiet as it was before work terminals stopped tabbing
                 themselves into the panel. -->
            <button
                v-if="agentTerminal"
                type="button"
                class="shrink-0 transition-opacity hover:text-content"
                :class="[running && live ? '' : 'opacity-0 group-hover/tool:opacity-100', { 'ml-auto': !unfinished && !view.summary }]"
                v-tooltip.top="'Watch in terminal'"
                aria-label="Watch in terminal"
                @click="openWorkTerminal(agentTerminal)"
            >
                <Icon name="desktop" class="text-2xs" />
            </button>
            <!-- The same door, onto the live page instead of the live shell. -->
            <button
                v-if="agentBrowser"
                type="button"
                class="shrink-0 transition-opacity hover:text-content"
                :class="[running && live ? '' : 'opacity-0 group-hover/tool:opacity-100', { 'ml-auto': !unfinished && !view.summary }]"
                v-tooltip.top="'Watch the browser'"
                aria-label="Watch the browser"
                @click="watchBrowser(agentBrowser)"
            >
                <Icon name="globe" class="text-2xs" />
            </button>
            <!-- And the third: onto the child's own transcript. Unlike the two above this one is NOT hover-only
                 once settled — a finished delegation's transcript is the record of work the parent only summarized,
                 which is exactly what somebody scrolling back is looking for. -->
            <RouterLink
                v-if="subagent"
                :to="`/subagents/${tool.id}`"
                class="shrink-0 transition-colors hover:text-content"
                v-tooltip.top="subagentLive ? 'Watch this agent' : `Open this agent's transcript`"
                :aria-label="subagentLive ? 'Watch this agent' : `Open this agent's transcript`"
            >
                <Icon name="users" class="text-2xs" />
            </RouterLink>
        </div>
        <template v-if="isOpen">
            <!-- WHAT THE CHILD CONCLUDED — its own last words (a subagent's) or the tail of what it printed (a
                 delegation's). Above the nested calls on purpose: the answer is what the delegation was for, and
                 the work it did to get there is the detail underneath it. For a backgrounded child this arrives
                 well before the tool result, and is the only report there is until then. -->
            <p
                v-if="subagent?.summary"
                class="ml-4 whitespace-pre-wrap rounded border border-line bg-canvas px-2 py-1 text-2xs leading-relaxed"
                :class="subagent.error ? 'text-danger' : 'text-muted'"
            >
                {{ subagent.summary }}
            </p>
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
            <!-- What the agent produced or looked at. The bytes are already in the workspace (browser captures
                 and generated images both live under .intentic/artifacts), so this path uses the same cache as
                 attachment chips — and a click opens the file itself, full size, in the workspace. -->
            <button
                v-for="image in view.images"
                :key="image.path"
                type="button"
                class="ml-4 overflow-hidden rounded border border-line bg-canvas text-left"
                v-tooltip.top="'Open in workspace'"
                @click="openWorkspaceRef(image.path, undefined, linkScope)"
            >
                <img
                    v-if="attachmentPreview(image.path)"
                    :src="attachmentPreview(image.path)"
                    :alt="image.path"
                    class="max-h-80 w-full object-contain"
                />
                <span v-else class="block px-2 py-1 font-mono text-2xs text-subtle">{{ image.path }}</span>
            </button>
            <ChatToolDiff
                v-for="diff in view.diffs"
                :key="diff.path"
                :path="diff.path"
                :old-text="diff.oldText"
                :new-text="diff.newText"
                :truncated="diff.truncated"
                @open="openWorkspaceRef(diff.path, undefined, linkScope)"
            />
            <!-- Three body shapes, chosen by the registry. `command` renders the invocation above its output
                 so a Bash card reads like a terminal; `files` turns a path listing into rows that navigate. -->
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
                <button
                    v-for="(entry, index) in view.body.entries"
                    :key="`${entry.path}:${entry.line ?? ''}:${index}`"
                    type="button"
                    class="flex items-baseline gap-1.5 rounded px-1 py-0.5 text-left font-mono text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                    v-tooltip.top="'Open in workspace'"
                    @click="openWorkspaceRef(entry.path, entry.line, linkScope)"
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
