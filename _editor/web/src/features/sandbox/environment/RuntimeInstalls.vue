<script setup lang="ts">
import type { EnvironmentRecurring } from "@intentic/api-contract";
import { BrandMark, Code, DisclosureRow, RowGroup, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { runtimeInstallVisual } from "./environmentVisual";

// The daemon's cross-session record of what sessions install at runtime: auto-drafted into the proposal where a step
// follows from the package name, surfaced here otherwise. Every row ends somewhere: add its step, hand the routing
// judgement to an agent, or dismiss it.

const { entries, canOperate, busy } = defineProps<{
    entries: readonly EnvironmentRecurring[];
    canOperate: boolean;
    busy: boolean;
}>();

const emit = defineEmits<{ decide: [tool: string, decision: `adopt` | `dismiss` | `restore`] }>();

const open = ref(new Set<string>());
const toggle = (tool: string): void => {
    const next = new Set(open.value);
    if (!next.delete(tool)) {
        next.add(tool);
    }
    open.value = next;
};

// A dismissed entry folds out of the list and its count, not just greyed in place; the tombstone is permanent, so it
// stays reachable behind the header's fold with an Undo.
const revealed = ref(false);
const byRecency = (left: EnvironmentRecurring, right: EnvironmentRecurring): number => right.lastAt - left.lastAt;
const awaiting = computed(() => entries.filter((entry) => entry.declined !== true).toSorted(byRecency));
const dismissed = computed(() => entries.filter((entry) => entry.declined === true).toSorted(byRecency));
// Revealed rows land after the ones still asking something; unfolding doesn't re-sort them.
const shown = computed(() => (revealed.value ? [...awaiting.value, ...dismissed.value] : awaiting.value));
// undefined, not '0 items', once nothing is awaiting: an empty count is the section saying it's settled.
const countLabel = computed(() =>
    awaiting.value.length === 0 ? undefined : `${awaiting.value.length} ${awaiting.value.length === 1 ? `item` : `items`}`,
);

// Dismissing also closes the row, so revealing the fold later opens on headlines, not whatever was expanded.
const decide = (entry: EnvironmentRecurring, decision: `adopt` | `dismiss` | `restore`): void => {
    if (decision === `dismiss` && open.value.has(entry.tool)) {
        toggle(entry.tool);
    }
    emit(`decide`, entry.tool, decision);
};

// Counts sessions, not install attempts: a session that retried an install several times still needed the tool once.
const sessionsLabel = (entry: EnvironmentRecurring): string => (entry.sessions === 1 ? `1 session` : `${entry.sessions} sessions`);

// `live` isn't a badge: almost every row is currently present, so a badge for it would be a tick on every line; it
// shows up in the opened row's sentence instead.
const STATES = {
    drafted: { icon: `sparkles`, label: `proposed`, tone: `text-link` },
    declined: { icon: `eye-slash`, label: `dismissed`, tone: `text-subtle` },
} as const;
const stateOf = (entry: EnvironmentRecurring) => (entry.declined === true ? STATES.declined : entry.drafted === true ? STATES.drafted : undefined);

// Explains per ecosystem, not with one shrug: the reason a step can't be templated differs each time, and the reader
// needs it to judge the agent's answer.
const NO_STEP: Partial<Record<EnvironmentRecurring[`kind`], string>> = {
    pip: `Where a Python package belongs is a routing decision — a virtualenv, a Debian package, or pipx — and it is a fact about this workspace rather than about the package.`,
    pipx: `pipx installs into a per-tool virtualenv under the home directory, which a rebuild recreates empty; making it durable means deciding what it should become instead.`,
    gem: `A Ruby gem's step depends on which Ruby is meant to own it, and this sandbox does not pin one.`,
    go: `The ledger records the binary's name, not the module path it came from, so there is nothing here to template.`,
    other: `Replaying a shell installer would bake whatever its command line carried, which is not a decision a template gets to make.`,
};
const noStep = (entry: EnvironmentRecurring): string =>
    NO_STEP[entry.kind] ?? `This ecosystem has no Dockerfile step that follows from a package name alone.`;

// Leads with the row's state in one sentence: the badges are a word each, and proposed vs. dismissed is the actual
// choice being read.
const explanation = (entry: EnvironmentRecurring): string => {
    if (entry.declined === true) {
        return `Dismissed. Nothing will propose a step for it again, and sessions may go on installing it.`;
    }
    if (entry.drafted === true) {
        return `A step for this is already in the proposal above, waiting for your approval. Approving it bakes the tool into the image on the next rebuild.`;
    }
    const lost = entry.live ? `It is in the container right now and the next rebuild loses it.` : `The container does not have it at the moment.`;
    return entry.step === undefined
        ? `${lost} ${noStep(entry)}`
        : `${lost} Its Dockerfile step follows from the package name, so it can be added as it stands.`;
};

// Carries what the turn can't recover itself (tool, ecosystem, repeat count) and names the target file, so two agents
// converge on one draft. Doesn't presume an image step: the tool may belong elsewhere.
const brief = (entry: EnvironmentRecurring): string =>
    `This sandbox has installed \`${entry.tool}\` (${entry.kind}) at runtime in ${sessionsLabel(entry)}, so it is lost on every container rebuild. ` +
    `Work out where it actually belongs. If it belongs in the sandbox image, load the \`environment\` skill and write the overlay step as ` +
    `\`.intentic/config/environment.d/${entry.tool.replace(/[^a-zA-Z0-9._-]+/g, `-`)}.Dockerfile\` for me to approve. ` +
    `If it belongs to a project instead — a virtualenv, a devDependency, a package script — set it up there and tell me that is what you did.`;
</script>

<template>
    <!-- `flat undivided`, like the sections above: this list is already inside the Environment card's own frame. -->
    <RowGroup
        flat
        undivided
        label="Installed at runtime"
        :count="countLabel"
        :caption="awaiting.length ? `Not in the image, so every rebuild loses them.` : undefined"
    >
        <!--
            The fold lives in the header, not as a row: it's a fact about the list, not an entry in it. `aria-pressed`, not `aria-expanded`, since it
            filters which rows are drawn rather than opening a region.
        -->
        <template v-if="dismissed.length" #actions>
            <button
                type="button"
                :aria-pressed="revealed"
                v-tooltip.top="revealed ? `Hide what you have dismissed` : `Show what you have dismissed`"
                :class="ui.linkButton(`gap-1 text-2xs font-medium text-subtle hover:text-content`)"
                @click="revealed = !revealed"
            >
                <Icon :name="revealed ? `eye` : `eye-slash`" />{{ dismissed.length }} dismissed
            </button>
        </template>

        <DisclosureRow
            v-for="entry in shown"
            :key="entry.tool"
            :class="entry.declined === true ? `opacity-70` : undefined"
            :open="open.has(entry.tool)"
            @update:open="toggle(entry.tool)"
        >
            <template #lead="{ mark }">
                <BrandMark
                    :size="mark"
                    :name="entry.tool"
                    :logo="runtimeInstallVisual(entry.tool, entry.kind).logo"
                    :icon="runtimeInstallVisual(entry.tool, entry.kind).icon"
                    :idle="entry.declined === true"
                />
            </template>
            <!--
                Same line order as a contents row: name, then the mono annotation. Here the name yields instead of the annotation, since there's no
                sentence to give up width, and clipping the recurrence would hide the fact this row exists to report.
            -->
            <template #title>
                <span class="flex min-w-0 items-center gap-3 overflow-hidden">
                    <!-- `font-normal`: mono at the row title's own weight reads louder than the sans names above it. -->
                    <span v-tooltip.bottom.overflow="entry.tool" class="min-w-0 truncate font-mono font-normal">{{ entry.tool }}</span>
                    <span class="shrink-0 font-mono text-2xs font-normal tabular-nums text-subtle">
                        {{ entry.kind }}<span class="text-muted"> · {{ sessionsLabel(entry) }}</span>
                    </span>
                </span>
            </template>
            <template #meta>
                <span v-if="stateOf(entry) !== undefined" :class="stateOf(entry)?.tone" class="inline-flex items-center gap-1 font-medium">
                    <Icon :name="stateOf(entry)!.icon" />{{ stateOf(entry)!.label }}
                </span>
            </template>
            <template #below>
                <div class="flex flex-col gap-3">
                    <p class="text-xs leading-relaxed text-muted">{{ explanation(entry) }}</p>
                    <!--
                        Shows the exact step 'Add to the image' would apply, so the button can be judged, not trusted; hidden on a dismissed row so
                        it doesn't look like it's still asking.
                    -->
                    <Code
                        v-if="entry.step !== undefined && entry.declined !== true"
                        :code="entry.step"
                        lang="docker"
                        :label="entry.drafted === true ? `What it adds to the proposal` : `What this would add`"
                        :clamp-lines="10"
                    />
                    <!-- Quiet by design: the tab's one filled shape is the strip's pills, and these sit inside a row already opened on purpose. -->
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <button
                            v-if="canOperate && entry.step !== undefined && entry.drafted !== true && entry.declined !== true"
                            type="button"
                            :disabled="busy"
                            :class="ui.linkButton(`gap-1 text-2xs font-medium text-link`)"
                            @click="decide(entry, `adopt`)"
                        >
                            <Icon name="plus" />Add to the image
                        </button>
                        <button
                            v-if="entry.step === undefined && entry.declined !== true"
                            type="button"
                            :class="ui.linkButton(`gap-1 text-2xs font-medium text-link`)"
                            @click="startAgent(brief(entry))"
                        >
                            <Icon name="sparkles" />Ask an agent where it belongs
                        </button>
                        <button
                            v-if="canOperate"
                            type="button"
                            :disabled="busy"
                            :class="ui.linkButton(`gap-1 text-2xs text-subtle hover:text-content`)"
                            @click="decide(entry, entry.declined === true ? `restore` : `dismiss`)"
                        >
                            <Icon :name="entry.declined === true ? `undo` : `eye-slash`" />{{ entry.declined === true ? `Undo` : `Dismiss` }}
                        </button>
                    </div>
                </div>
            </template>
        </DisclosureRow>
    </RowGroup>
</template>
