<script setup lang="ts">
import type { SafetyLogEntry } from "@intentic-app/api-contract";
import {
    Code,
    DisclosureRow,
    FilterBar,
    formatDateTime,
    Icon,
    type IconName,
    Notice,
    RowGroup,
    RowNote,
    SegmentedControl,
    SkeletonRows,
    StatusBadge,
    type StatusVariant,
    timeAgo,
} from "@intentic/ui";
import { computed, ref } from "vue";
import { useSafetyLog } from "../../../composables/sandbox/useSafetyPolicy";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";

/* WHAT THE POLICY ABOVE ACTUALLY DID, and the half of this page that makes the other half writable.
 *
 * The page this replaced was six switches and no evidence. You could see that "delete files recursively" was
 * set to ask, and you could not see that it had asked you eleven times that week, nine of them about a search
 * whose pattern happened to look like a deletion. That is precisely the information needed to write a better
 * rule, and it existed nowhere.
 *
 * Prose makes that worse before it makes it better — a policy can say anything, and an owner who cannot see
 * what their words did has no way to discover that "be strict about deletes" is being read more strictly than
 * they meant. So every verdict is here, INCLUDING the allowed ones, which are most of them and are the entries
 * that matter: a card you answered is something you already know about, and a command waved through on your
 * policy's say-so is not. "Why wasn't I asked about that" is the question this list exists to answer.
 *
 * COLLAPSED IS THE CLAIM; EXPANDED IS THE EVIDENCE.
 * What used to be fifty raw paragraphs and multiline pre blocks stacked in a single unfilterable column is now
 * structured as disclosure rows:
 *   · Collapsed: an at-a-glance scannable timeline of commands, their gate verdict, and relative timing.
 *   · Expanded: the safety judge's full assessment, the syntax-highlighted command with copy affordance, and
 *     triage metadata.
 *   · Instrument: full-text search across commands and reasoning, paired with outcome filters and live tally badges.
 */

type OutcomeFilter = "all" | "ran" | "asked" | "refused";

const { entries, isLoading, error } = useSafetyLog();
const { settings } = useSandboxSettings();
// Only read for the empty state, which is the one line this list can get outright wrong when nothing is judging.
const judgeOff = computed(() => settings.value?.commandJudge === `off`);

interface DecisionStatus {
    label: string;
    variant: StatusVariant;
    dot: boolean;
    icon: IconName;
    iconTone: string;
}

const statusOf = (entry: SafetyLogEntry): DecisionStatus => {
    if (entry.answer === `allowed`) {
        return { label: `You allowed it`, variant: `success`, dot: true, icon: `check`, iconTone: `text-success` };
    }
    if (entry.answer === `declined`) {
        return { label: `You declined it`, variant: `danger`, dot: true, icon: `times`, iconTone: `text-danger` };
    }
    /* THE ROW THE WATCH STATE EXISTS TO PRODUCE, and the whole reason the log carries the judge's decision
     * separately from what the gate did. A verdict of `ask` or `refuse` beside an outcome of `allowed` means the
     * judge would have stopped this and was not allowed to, so the row has to say both halves — "Ran" alone
     * would hide exactly the disagreement somebody switched to Watch to go looking for. */
    if (entry.outcome === `allowed` && entry.decision !== `allow`) {
        return {
            label: entry.decision === `refuse` ? `Ran · would refuse` : `Ran · would ask`,
            variant: `warning`,
            dot: true,
            icon: `exclamation-triangle`,
            iconTone: `text-warning`,
        };
    }
    if (entry.outcome === `refused`) {
        return { label: `Refused`, variant: `danger`, dot: true, icon: `times`, iconTone: `text-danger` };
    }
    if (entry.outcome === `asked`) {
        return { label: `Asked you`, variant: `warning`, dot: true, icon: `question-circle`, iconTone: `text-warning` };
    }
    return { label: `Ran`, variant: `neutral`, dot: false, icon: `check`, iconTone: `text-subtle` };
};

const counts = computed(() => {
    let ran = 0;
    let asked = 0;
    let refused = 0;
    for (const entry of entries.value) {
        if (entry.outcome === `allowed`) {
            ran++;
        }
        if (entry.outcome === `asked` || entry.answer !== undefined) {
            asked++;
        }
        if (entry.outcome === `refused` || entry.answer === `declined`) {
            refused++;
        }
    }
    return { all: entries.value.length, ran, asked, refused };
});

const filterOptions = computed(() => [
    { label: `All`, value: `all` as const, badge: counts.value.all },
    { label: `Ran`, value: `ran` as const, badge: counts.value.ran },
    { label: `Asked`, value: `asked` as const, badge: counts.value.asked },
    { label: `Refused`, value: `refused` as const, badge: counts.value.refused },
]);

const query = ref(``);
const outcomeFilter = ref<OutcomeFilter>(`all`);

const matchesSearch = (entry: SafetyLogEntry, q: string): boolean => {
    if (!q) {
        return true;
    }
    const lower = q.toLowerCase();
    return (
        entry.program.toLowerCase().includes(lower) ||
        entry.sentence.toLowerCase().includes(lower) ||
        (entry.machine !== undefined && entry.machine.toLowerCase().includes(lower)) ||
        entry.classes.some((c) => c.toLowerCase().includes(lower))
    );
};

const filteredEntries = computed(() => {
    const q = query.value.trim();
    return entries.value.filter((entry) => {
        if (outcomeFilter.value === `ran` && entry.outcome !== `allowed`) {
            return false;
        }
        if (outcomeFilter.value === `asked` && entry.outcome !== `asked` && entry.answer === undefined) {
            return false;
        }
        if (outcomeFilter.value === `refused` && entry.outcome !== `refused` && entry.answer !== `declined`) {
            return false;
        }
        return matchesSearch(entry, q);
    });
});

const INITIAL_LIMIT = 15;
const expandedList = ref(false);
const isFiltering = computed(() => query.value.trim() !== `` || outcomeFilter.value !== `all`);
const shouldCollapse = computed(() => !isFiltering.value && filteredEntries.value.length > INITIAL_LIMIT);
const visibleEntries = computed(() => {
    if (!shouldCollapse.value || expandedList.value) {
        return filteredEntries.value;
    }
    return filteredEntries.value.slice(0, INITIAL_LIMIT);
});
const hiddenCount = computed(() => filteredEntries.value.length - INITIAL_LIMIT);

const opened = ref<Set<string>>(new Set());
const entryKey = (entry: SafetyLogEntry): string => `${entry.at}-${entry.program}`;
const toggle = (key: string, open: boolean): void => {
    const next = new Set(opened.value);
    if (open) {
        next.add(key);
    } else {
        next.delete(key);
    }
    opened.value = next;
};

const commandSummary = (program: string): string => {
    const trimmed = program.trim();
    const firstLine = trimmed.split(`\n`)[0]?.trim() ?? ``;
    return firstLine || program;
};

const groupCount = computed(() => {
    if (entries.value.length === 0) {
        return undefined;
    }
    if (isFiltering.value) {
        return `${filteredEntries.value.length} of ${entries.value.length}`;
    }
    return entries.value.length;
});
</script>

<template>
    <div class="flex flex-col gap-3">
        <!-- The filter and search instrument above recent decisions, rendered only when there are entries to search -->
        <FilterBar
            v-if="entries.length > 0"
            v-model="query"
            placeholder="Filter decisions by command, reason, machine…"
            :count="filteredEntries.length"
            clearable
        >
            <template #controls>
                <SegmentedControl v-model="outcomeFilter" size="xs" :options="filterOptions" />
            </template>
        </FilterBar>

        <RowGroup label="Recent decisions" :count="groupCount">
            <SkeletonRows v-if="isLoading" :rows="4" description />

            <RowNote v-else-if="error !== undefined" variant="block">
                <Notice tone="danger">{{ error }}</Notice>
            </RowNote>

            <!-- An empty list is a real and common state (nothing the assistant ran matched anything worth judging),
                 and it needs saying, or the group reads as broken. With the judge off it is not that state at all:
                 nothing is being judged, so nothing will ever appear here, and saying "nothing has needed judging"
                 would be the page quietly agreeing that its own switch had no effect. -->
            <RowNote v-else-if="entries.length === 0" variant="empty">
                <template v-if="judgeOff">The safety judge is off, so nothing is being judged and nothing is recorded here.</template>
                <template v-else>
                    Nothing has needed judging yet. Ordinary work — building, testing, editing, committing — never reaches the policy at all.
                </template>
            </RowNote>

            <RowNote v-else-if="visibleEntries.length === 0" variant="empty">
                <template v-if="query.trim() !== ''">
                    No decisions match "{{ query.trim() }}".
                </template>
                <template v-else>
                    No {{ outcomeFilter }} decisions recorded yet.
                </template>
            </RowNote>

            <template v-else>
                <DisclosureRow
                    v-for="entry in visibleEntries"
                    :key="entryKey(entry)"
                    :open="opened.has(entryKey(entry))"
                    body="rail"
                    @update:open="(val) => toggle(entryKey(entry), val)"
                >
                    <template #lead>
                        <Icon :name="statusOf(entry).icon" class="text-xs" :class="statusOf(entry).iconTone" />
                    </template>

                    <template #title>
                        <span class="block truncate font-mono text-xs text-content" :title="entry.program">
                            {{ commandSummary(entry.program) }}
                        </span>
                    </template>

                    <template #description>
                        <span class="block truncate text-2xs text-muted" :title="entry.sentence">
                            {{ entry.sentence }}
                        </span>
                    </template>

                    <template #meta>
                        <span
                            v-if="entry.machine"
                            class="hidden items-center gap-1 font-mono text-2xs text-subtle sm:inline-flex"
                            :title="`Ran on ${entry.machine}`"
                        >
                            <Icon name="desktop" class="text-3xs" />
                            {{ entry.machine }}
                        </span>
                        <StatusBadge
                            :variant="statusOf(entry).variant"
                            :label="statusOf(entry).label"
                            size="xs"
                            :dot="statusOf(entry).dot"
                        />
                        <span class="shrink-0 text-2xs text-subtle" :title="formatDateTime(entry.at)">
                            {{ timeAgo(entry.at) }}
                        </span>
                    </template>

                    <template #below>
                        <div class="flex flex-col gap-3 py-1 text-xs">
                            <div>
                                <div class="text-2xs font-medium uppercase tracking-wider text-subtle">Judge Assessment</div>
                                <p class="mt-1 leading-relaxed text-content/90">{{ entry.sentence }}</p>
                            </div>

                            <div>
                                <div class="mb-1 text-2xs font-medium uppercase tracking-wider text-subtle">Program / Command</div>
                                <Code :code="entry.program" lang="bash" :wrap="true" />
                            </div>

                            <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1 text-2xs text-muted">
                                <span class="inline-flex items-center gap-1.5">
                                    <span class="text-subtle">Judge:</span>
                                    <span class="font-medium text-content capitalize">{{ entry.decision }}</span>
                                </span>
                                <span class="inline-flex items-center gap-1.5">
                                    <span class="text-subtle">Gate:</span>
                                    <span class="font-medium text-content capitalize">{{ entry.outcome }}</span>
                                </span>
                                <span v-if="entry.answer" class="inline-flex items-center gap-1.5">
                                    <span class="text-subtle">Your response:</span>
                                    <span class="font-medium text-content capitalize">{{ entry.answer }}</span>
                                </span>
                                <span v-if="entry.machine" class="inline-flex items-center gap-1.5">
                                    <span class="text-subtle">Target:</span>
                                    <span class="font-medium text-content">{{ entry.machine }}</span>
                                </span>
                                <span v-if="entry.classes.length > 0" class="inline-flex items-center gap-1.5">
                                    <span class="text-subtle">Triage:</span>
                                    <span class="flex flex-wrap gap-1">
                                        <span
                                            v-for="cls in entry.classes"
                                            :key="cls"
                                            class="rounded bg-content/5 px-1.5 py-0.5 font-mono text-3xs text-subtle"
                                        >
                                            {{ cls }}
                                        </span>
                                    </span>
                                </span>
                                <span class="ml-auto font-mono text-subtle">
                                    {{ formatDateTime(entry.at) }}
                                </span>
                            </div>
                        </div>
                    </template>
                </DisclosureRow>

                <RowNote
                    v-if="shouldCollapse"
                    variant="action"
                    :icon="expandedList ? 'chevron-up' : 'chevron-down'"
                    :label="expandedList ? 'Show fewer decisions' : `Show ${hiddenCount} older decisions`"
                    @click="expandedList = !expandedList"
                />
            </template>
        </RowGroup>
    </div>
</template>
