<script setup lang="ts">
import type { EnvironmentRecurring } from "@intentic/sandbox-contract/schemas/environment";
import { BrandMark, Button, Code, Section, timeAgo, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import { startAgent } from "../../../models/fleet/agentActions";
import { runtimeInstallVisual } from "./environmentVisual";
import { useT } from "@intentic/ui/i18n";

// The daemon's cross-session record of what sessions install at runtime: auto-drafted into the proposal where a step
// follows from the package name, surfaced here otherwise. Every row ends somewhere: add its step, hand the routing
// judgement to an agent, or dismiss it. It sits under the Contents sections, so it draws as they do: flat on the card,
// flush with their left edge, a rule between rows rather than a box around each.

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

// `live` isn't a badge: almost every row is currently present, so a badge for it would be a tick on every line.
const STATES = {
    drafted: { icon: `sparkles`, label: () => t(`sandbox.runtimeInstalls.proposed`), tone: `text-link` },
    declined: { icon: `eye-slash`, label: () => t(`sandbox.runtimeInstalls.dismissed`), tone: `text-subtle` },
} as const;
const stateOf = (entry: EnvironmentRecurring) => (entry.declined === true ? STATES.declined : entry.drafted === true ? STATES.drafted : undefined);

// The verbs a row answers with, on its headline so deciding takes no opening: a step to add where one follows from the
// package name, an agent where it takes judgement, and the way out (or back) for each.
const canAdd = (entry: EnvironmentRecurring): boolean => canOperate && entry.step !== undefined && entry.drafted !== true && entry.declined !== true;
const asksAgent = (entry: EnvironmentRecurring): boolean => entry.step === undefined && entry.declined !== true;

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

// Only what the headline and the evidence don't already say: an answer already given, why no step follows, or that the
// container lacks the tool now, which reads as "it went somewhere else" beside the commands that installed it.
const explanation = (entry: EnvironmentRecurring): string | undefined => {
    if (entry.declined === true) {
        return t(`sandbox.runtimeInstalls.explainDismissed`);
    }
    if (entry.drafted === true) {
        return t(`sandbox.runtimeInstalls.explainDrafted`);
    }
    const said = [entry.live ? undefined : t(`sandbox.runtimeInstalls.notPresent`), entry.step === undefined ? noStep(entry) : undefined].filter(
        (part) => part !== undefined,
    );
    return said.length > 0 ? said.join(` `) : undefined;
};

// Carries what the turn can't recover itself (tool, ecosystem, repeat count, the commands) and names the target file, so
// two agents converge on one draft. Doesn't presume an image step: the tool may belong elsewhere.
// The brief is the agent's prompt, so it stays English whatever the reader's language.
const brief = (entry: EnvironmentRecurring): string =>
    `This sandbox has installed \`${entry.tool}\` (${entry.kind}) at runtime in ${entry.sessions === 1 ? `1 session` : `${entry.sessions} sessions`}, so it is lost on every container rebuild. ${ 
    entry.commands !== undefined && entry.commands.length > 0 ? `The sessions ran: ${entry.commands.map((command) => `\`${command}\``).join(`; `)}. ` : `` 
    }Work out where it actually belongs. If it belongs in the sandbox image, load the \`environment\` skill and write the overlay step as ` +
    `\`.intentic/config/environment.d/${entry.tool.replace(/[^a-zA-Z0-9._-]+/g, `-`)}.Dockerfile\` for me to approve. ` +
    `If it belongs to a project instead — a virtualenv, a devDependency, a package script — set it up there and tell me that is what you did.`;
</script>

<template>
    <Section :label="t(`sandbox.runtimeInstalls.installedAtRuntime`)">
        <!-- Why the list matters, said once beside its name rather than as an indented line of its own. -->
        <template v-if="awaiting.length" #info>
            <span class="text-xs text-subtle">{{ t(`sandbox.runtimeInstalls.lostOnRebuild`) }}</span>
        </template>
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

        <ul v-if="shown.length" class="flex flex-col divide-y divide-line-subtle">
            <li v-for="entry in shown" :key="entry.tool" data-runtime-install :class="entry.declined === true ? `opacity-70` : undefined">
                <!-- Wraps on a narrow card: the verbs drop under the name rather than squeezing it to an ellipsis. -->
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                    <button
                        type="button"
                        :aria-expanded="open.has(entry.tool)"
                        class="group flex min-w-40 flex-1 items-center gap-2.5 rounded-sm py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500"
                        @click="toggle(entry.tool)"
                    >
                        <BrandMark
                            plain
                            :size="18"
                            :name="entry.tool"
                            :logo="runtimeInstallVisual(entry.tool, entry.kind).logo"
                            :icon="runtimeInstallVisual(entry.tool, entry.kind).icon"
                            :idle="entry.declined === true"
                        />
                        <!-- Two lines, as a row's title over its description: the name keeps the width, the mono facts sit
                             under it, and neither squeezes the other to an ellipsis beside the verbs. -->
                        <span class="flex min-w-0 flex-col">
                            <span class="flex min-w-0 items-center gap-2">
                                <span v-tooltip.bottom.overflow="entry.tool" class="min-w-0 truncate text-sm font-medium text-content">{{ entry.tool }}</span>
                                <span
                                    v-if="stateOf(entry) !== undefined"
                                    :class="stateOf(entry)?.tone"
                                    class="inline-flex shrink-0 items-center gap-1 text-2xs font-medium"
                                >
                                    <Icon :name="stateOf(entry)!.icon" />{{ stateOf(entry)!.label() }}
                                </span>
                            </span>
                            <span class="truncate font-mono text-2xs tabular-nums text-subtle">
                                {{ entry.kind }} · {{ sessionsLabel(entry) }} · {{ timeAgo(entry.lastAt, { days: true }) }}
                            </span>
                        </span>
                        <!-- Rotation, not an icon swap, as a disclosure row's mark turns. -->
                        <Icon
                            name="chevron-right"
                            class="shrink-0 text-xs text-subtle transition group-hover:text-muted"
                            :class="open.has(entry.tool) ? `rotate-90` : ``"
                            aria-hidden="true"
                        />
                    </button>
                    <!-- Repeated down every row, so the way out is quiet; adding is the one filled press, as on the mock-up the
                         owner chose and as the tier rule asks of a plus. -->
                    <div class="ml-auto flex shrink-0 items-center gap-1">
                        <Button v-if="canAdd(entry)" size="small" tier="boring" :label="t(`sandbox.runtimeInstalls.addToImage`)" :disabled="busy" @click="decide(entry, `adopt`)">
                            <template #icon><Icon name="plus" /></template>
                        </Button>
                        <Button v-if="asksAgent(entry)" size="small" tier="quiet" :label="t(`sandbox.runtimeInstalls.askAgent`)" @click="startAgent(brief(entry))">
                            <template #icon><Icon name="sparkles" /></template>
                        </Button>
                        <Button
                            v-if="canOperate"
                            size="small"
                            tier="quiet"
                            :label="entry.declined === true ? t(`ui.action.undo`) : t(`ui.action.dismiss`)"
                            :disabled="busy"
                            @click="decide(entry, entry.declined === true ? `restore` : `dismiss`)"
                        />
                    </div>
                </div>

                <!-- The evidence, indented to the name: who installed it and how, then what a press would add. -->
                <div v-if="open.has(entry.tool)" class="flex flex-col gap-3 pb-3 pl-7">
                    <p v-if="explanation(entry) !== undefined" class="text-xs leading-relaxed text-muted">{{ explanation(entry) }}</p>
                    <dl v-if="entry.sessionIds?.length || entry.commands?.length" class="flex flex-col gap-1.5 text-2xs">
                        <div v-if="entry.sessionIds?.length" class="flex gap-3">
                            <dt class="w-20 shrink-0 text-subtle">{{ t(`sandbox.runtimeInstalls.installedBy`) }}</dt>
                            <dd class="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 font-mono">
                                <RouterLink
                                    v-for="session in entry.sessionIds"
                                    :key="session"
                                    :to="`/agents/${encodeURIComponent(session)}`"
                                    class="max-w-full truncate text-link hover:underline"
                                >
                                    {{ session }}
                                </RouterLink>
                            </dd>
                        </div>
                        <div v-if="entry.commands?.length" class="flex gap-3">
                            <dt class="w-20 shrink-0 text-subtle">{{ t(`sandbox.runtimeInstalls.commands`) }}</dt>
                            <!-- Wrapped whole, not truncated: a `--prefix` at the end of a line is often the whole story. -->
                            <dd class="flex min-w-0 flex-col gap-1 font-mono text-muted">
                                <code v-for="command in entry.commands" :key="command" class="whitespace-pre-wrap break-words">{{ command }}</code>
                            </dd>
                        </div>
                    </dl>
                    <!-- Show the exact install step so the action is inspectable. -->
                    <Code
                        v-if="entry.step !== undefined && entry.declined !== true"
                        :code="entry.step"
                        lang="docker"
                        :label="entry.drafted === true ? t(`sandbox.runtimeInstalls.whatAddsToProposal`) : t(`sandbox.runtimeInstalls.whatWouldAdd`)"
                        :clamp-lines="10"
                    />
                </div>
            </li>
        </ul>
    </Section>
</template>
