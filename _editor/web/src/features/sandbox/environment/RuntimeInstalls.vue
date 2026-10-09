<script setup lang="ts">
import type { EnvironmentRecurring } from "@intentic/sandbox-contract";
import { BrandMark, Code, DisclosureRow, RowGroup, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { runtimeInstallVisual } from "./environmentVisual";
import { useT } from "@intentic/ui/i18n";

// The daemon's cross-session record of what sessions install at runtime: auto-drafted into the proposal where a step
// follows from the package name, surfaced here otherwise. Every row ends somewhere: add its step, hand the routing
// judgement to an agent, or dismiss it.

const t = useT();

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

// Dismissing also closes the row, so revealing the fold later opens on headlines, not whatever was expanded.
const decide = (entry: EnvironmentRecurring, decision: `adopt` | `dismiss` | `restore`): void => {
    if (decision === `dismiss` && open.value.has(entry.tool)) {
        toggle(entry.tool);
    }
    emit(`decide`, entry.tool, decision);
};

// Counts sessions, not install attempts: a session that retried an install several times still needed the tool once.
const sessionsLabel = (entry: EnvironmentRecurring): string => t(`sandbox.runtimeInstalls.sessions`, { count: entry.sessions }, entry.sessions);

// `live` isn't a badge: almost every row is currently present, so a badge for it would be a tick on every line; it
// shows up in the opened row's sentence instead. Labels are functions, so they follow a language switch.
const STATES = {
    drafted: { icon: `sparkles`, label: () => t(`sandbox.runtimeInstalls.proposed`), tone: `text-link` },
    declined: { icon: `eye-slash`, label: () => t(`sandbox.runtimeInstalls.dismissed`), tone: `text-subtle` },
} as const;
const stateOf = (entry: EnvironmentRecurring) => (entry.declined === true ? STATES.declined : entry.drafted === true ? STATES.drafted : undefined);

// Explains per ecosystem, not with one shrug: the reason a step can't be templated differs each time, and the reader
// needs it to judge the agent's answer.
const noStep = (entry: EnvironmentRecurring): string => {
    switch (entry.kind) {
        case `pip`:
            return t(`sandbox.runtimeInstalls.noStepPip`);
        case `pipx`:
            return t(`sandbox.runtimeInstalls.noStepPipx`);
        case `gem`:
            return t(`sandbox.runtimeInstalls.noStepGem`);
        case `go`:
            return t(`sandbox.runtimeInstalls.noStepGo`);
        case `other`:
            return t(`sandbox.runtimeInstalls.noStepOther`);
        default:
            return t(`sandbox.runtimeInstalls.noStepDefault`);
    }
};

// Leads with the row's state in one sentence: the badges are a word each, and proposed vs. dismissed is the actual
// choice being read.
const explanation = (entry: EnvironmentRecurring): string => {
    if (entry.declined === true) {
        return t(`sandbox.runtimeInstalls.explainDismissed`);
    }
    if (entry.drafted === true) {
        return t(`sandbox.runtimeInstalls.explainDrafted`);
    }
    const lost = entry.live ? t(`sandbox.runtimeInstalls.liveLost`) : t(`sandbox.runtimeInstalls.notPresent`);
    return entry.step === undefined ? `${lost} ${noStep(entry)}` : `${lost} ${t(`sandbox.runtimeInstalls.stepFollows`)}`;
};

// Carries what the turn can't recover itself (tool, ecosystem, repeat count) and names the target file, so two agents
// converge on one draft. Doesn't presume an image step: the tool may belong elsewhere.
// The brief is the agent's prompt, so it stays English whatever the reader's language.
const brief = (entry: EnvironmentRecurring): string =>
    `This sandbox has installed \`${entry.tool}\` (${entry.kind}) at runtime in ${entry.sessions === 1 ? `1 session` : `${entry.sessions} sessions`}, so it is lost on every container rebuild. ` +
    `Work out where it actually belongs. If it belongs in the sandbox image, load the \`environment\` skill and write the overlay step as ` +
    `\`.intentic/config/environment.d/${entry.tool.replace(/[^a-zA-Z0-9._-]+/g, `-`)}.Dockerfile\` for me to approve. ` +
    `If it belongs to a project instead — a virtualenv, a devDependency, a package script — set it up there and tell me that is what you did.`;
</script>

<template>
    <!-- `flat undivided`, like the sections above: this list is already inside the Environment card's own frame. -->
    <RowGroup
        flat
        undivided
        :label="t(`sandbox.runtimeInstalls.installedAtRuntime`)"
        :caption="awaiting.length ? t(`sandbox.runtimeInstalls.notInImageEvery`) : undefined"
    >
        <!-- The fold lives in the header, not as a row: it's a fact about the list, not an entry in it. -->
        <template v-if="dismissed.length" #actions>
            <button
                type="button"
                :aria-pressed="revealed"
                v-tooltip.top="revealed ? t(`sandbox.runtimeInstalls.hideDismissed`) : t(`sandbox.runtimeInstalls.showDismissed`)"
                :class="ui.textButton({ size: `xs`, tone: `subtle` }, `font-medium`)"
                @click="revealed = !revealed"
            >
                <Icon :name="revealed ? `eye` : `eye-slash`" />{{ t(`sandbox.runtimeInstalls.dismissedCount`, { count: dismissed.length }) }}
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
                <BrandMark plain
                    :size="mark"
                    :name="entry.tool"
                    :logo="runtimeInstallVisual(entry.tool, entry.kind).logo"
                    :icon="runtimeInstallVisual(entry.tool, entry.kind).icon"
                    :idle="entry.declined === true"
                />
            </template>
            <!-- Same line order as a contents row: name, then the mono annotation. -->
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
                    <Icon :name="stateOf(entry)!.icon" />{{ stateOf(entry)!.label() }}
                </span>
            </template>
            <template #below>
                <div class="flex flex-col gap-3">
                    <p class="text-xs leading-relaxed text-muted">{{ explanation(entry) }}</p>
                    <!-- Show the exact install step so the action is inspectable. -->
                    <Code
                        v-if="entry.step !== undefined && entry.declined !== true"
                        :code="entry.step"
                        lang="docker"
                        :label="entry.drafted === true ? t(`sandbox.runtimeInstalls.whatAddsToProposal`) : t(`sandbox.runtimeInstalls.whatWouldAdd`)"
                        :clamp-lines="10"
                    />
                    <!-- Install details stay quiet inside the already-open row. -->
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <button
                            v-if="canOperate && entry.step !== undefined && entry.drafted !== true && entry.declined !== true"
                            type="button"
                            :disabled="busy"
                            :class="ui.textButton({ size: `xs` }, `font-medium`)"
                            @click="decide(entry, `adopt`)"
                        >
                            <Icon name="plus" />{{ t(`sandbox.runtimeInstalls.addToImage`) }}
                        </button>
                        <button
                            v-if="entry.step === undefined && entry.declined !== true"
                            type="button"
                            :class="ui.textButton({ size: `xs` }, `font-medium`)"
                            @click="startAgent(brief(entry))"
                        >
                            <Icon name="sparkles" />{{ t(`sandbox.runtimeInstalls.askAgentWhereBelongs`) }}
                        </button>
                        <button
                            v-if="canOperate"
                            type="button"
                            :disabled="busy"
                            :class="ui.textButton({ size: `xs`, tone: `subtle` })"
                            @click="decide(entry, entry.declined === true ? `restore` : `dismiss`)"
                        >
                            <Icon :name="entry.declined === true ? `undo` : `eye-slash`" />{{
                                entry.declined === true ? t(`ui.action.undo`) : t(`ui.action.dismiss`)
                            }}
                        </button>
                    </div>
                </div>
            </template>
        </DisclosureRow>
    </RowGroup>
</template>
