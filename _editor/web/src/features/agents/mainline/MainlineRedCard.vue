<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import MainlineCard from "./MainlineCard.vue";
import { failuresOf, fixTone, type MainlineRed, projectName, routingMeta, sinceWhen } from "./mainlineView";
import { openLandConversation, useLandTitle } from "./openLanded";

// A PROJECT WHOSE CHECK AFTER LANDING FAILS, the Result lane's loudest card and the one a reader opened the board for.
// Under its name, since when it fails; at the end of that row, the check's terminal for the whole log. Then, each on a
// labelled row so no line has to be decoded: the command the check ran, who is fixing it, and the landed work it is
// laid at; and under them what failed, counted.

const t = useT();

const props = defineProps<{
    red: MainlineRed;
    // Opens the terminal its check ran in, from a sandbox that names one; absent while the project is being checked
    // again, since the running check's card is where its one terminal opens then.
    logs?: (() => void) | undefined;
    minute: number;
}>();

const landTitle = useLandTitle();

// How much of a red run the card lists before the rest wait behind a press, and how many of the lands it is laid at. The
// daemon keeps the first thirty failures; past those, the terminal is the place to read.
const FAILURES_SHOWN = 6;
const CAUSES_SHOWN = 3;

// A row's name, in its own column, so the values line up under one another.
const LABEL = `pt-0.5 text-2xs text-subtle`;

// Who has it, in one line: the conversation it names (the one fixing it, or the one it waits for), and why nobody was
// sent only when that leaves it to the reader.
const fix = computed(() => {
    const meta = routingMeta(props.red.fixer?.kind);
    const conversationId = meta.lead === undefined ? undefined : props.red.fixer?.conversationId;
    const detail = meta.state === `needs-you` ? props.red.fixer?.detail : undefined;
    return { meta, conversationId, detail };
});

const causesOpen = ref(false);
// A fold of one would be a press to read one title, so one more never folds.
const causesFold = computed(() => props.red.cause.length - CAUSES_SHOWN > 1);
const causes = computed(() => (causesFold.value && !causesOpen.value ? props.red.cause.slice(0, CAUSES_SHOWN) : props.red.cause));

const failuresOpen = ref(false);
const kept = computed(() => failuresOf(props.red.run));
// A fold of one would be a press to read one line, so one more never folds.
const failuresFold = computed(() => kept.value.length - FAILURES_SHOWN > 1);
const failures = computed(() => (failuresFold.value && !failuresOpen.value ? kept.value.slice(0, FAILURES_SHOWN) : kept.value));
// What the run named beyond what the card holds: behind the press while folded, in the terminal once open.
const failuresBeyond = computed(() => props.red.run.failureCount - failures.value.length);
</script>

<template>
    <MainlineCard :data-result="red.project" :title="projectName(red.project)" icon="times" tone="danger" live edge>
        <template #meta>
            <span class="min-w-0 truncate text-danger">{{ t(`agents.mainline.board.failingSince`, { time: sinceWhen(red.since, minute) }) }}</span>
        </template>
        <template v-if="logs !== undefined" #trailing>
            <button type="button" :class="ui.textAction(`shrink-0 gap-1 text-2xs`)" @click="logs()">
                <Icon name="terminal" class="text-2xs" />{{ t(`agents.mainline.logs`) }}
            </button>
        </template>
        <dl class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5">
            <dt :class="LABEL">{{ t(`agents.mainline.board.command`) }}</dt>
            <dd data-command class="min-w-0 truncate font-mono text-xs text-content" v-tooltip.top="red.run.command">{{ red.run.command }}</dd>

            <dt :class="LABEL">{{ t(`agents.mainline.board.fix`) }}</dt>
            <dd class="flex min-w-0 flex-col gap-0.5">
                <div data-fix class="flex min-w-0 items-center gap-1.5 text-xs" :class="fixTone(fix.meta.state)">
                    <Icon :name="fix.meta.icon" class="shrink-0 text-2xs" />
                    <template v-if="fix.conversationId !== undefined">
                        <span class="shrink-0">{{ fix.meta.lead }}</span>
                        <button type="button" :class="ui.linkButton(`min-w-0 text-xs`)" @click="openLandConversation(fix.conversationId)">
                            <span class="truncate">{{ landTitle(fix.conversationId) }}</span>
                        </button>
                    </template>
                    <span v-else class="min-w-0 truncate">{{ fix.meta.words }}</span>
                </div>
                <p v-if="fix.detail !== undefined" data-fix-detail class="text-2xs text-subtle">{{ fix.detail }}</p>
            </dd>

            <template v-if="red.cause.length > 0">
                <dt :class="LABEL">{{ t(`agents.mainline.likelyCause`) }}</dt>
                <dd data-cause class="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
                    <!-- The comma rides with the title before it, so a list that wraps never starts a line with one. -->
                    <span v-for="(land, index) in causes" :key="land.conversationId" class="flex min-w-0 max-w-full items-center text-subtle">
                        <button type="button" :class="ui.linkButton(`min-w-0 text-xs`)" @click="openLandConversation(land.conversationId, land.title)">
                            <span class="truncate">{{ landTitle(land.conversationId, land.title) }}</span>
                        </button>
                        <template v-if="index < causes.length - 1">,</template>
                    </span>
                    <button v-if="causesFold" type="button" :class="ui.textAction(`text-xs`)" :aria-expanded="causesOpen" @click="causesOpen = !causesOpen">
                        {{ causesOpen ? t(`ui.action.showFewer`) : t(`agents.mainline.board.more`, { count: red.cause.length - CAUSES_SHOWN }) }}
                    </button>
                </dd>
            </template>
        </dl>
        <!-- What failed, set in from the card like a terminal's excerpt and counted: test names first, the file each sits in after. -->
        <div v-if="red.run.failures.length > 0" class="flex min-w-0 flex-col gap-1.5 rounded-lg bg-content/5 px-2.5 py-2">
            <p data-failures-count class="text-2xs font-medium text-danger">
                {{ t(`agents.mainline.board.failures`, { count: red.run.failureCount }, red.run.failureCount) }}
            </p>
            <ul data-failures class="flex min-w-0 flex-col gap-1">
                <li v-for="(failure, index) in failures" :key="index" class="line-clamp-2 text-2xs wrap-anywhere">
                    <span class="text-muted" :class="failure.file === undefined ? `font-mono` : ``">{{ failure.name }}</span>
                    <span v-if="failure.file !== undefined" class="ml-1.5 font-mono text-subtle">{{ failure.file }}</span>
                </li>
                <li v-if="failuresFold" class="flex">
                    <button type="button" :class="ui.textAction(`min-h-7 text-2xs`)" :aria-expanded="failuresOpen" @click="failuresOpen = !failuresOpen">
                        {{ failuresOpen ? t(`ui.action.showFewer`) : t(`agents.mainline.moreFailures`, { count: failuresBeyond }) }}
                    </button>
                </li>
                <li v-if="(!failuresFold || failuresOpen) && failuresBeyond > 0" class="text-2xs text-subtle">
                    {{ t(`agents.mainline.moreFailures`, { count: failuresBeyond }) }}
                </li>
            </ul>
        </div>
        <p v-else class="text-2xs text-subtle">{{ t(`agents.mainline.noFailureList`) }}</p>
    </MainlineCard>
</template>
