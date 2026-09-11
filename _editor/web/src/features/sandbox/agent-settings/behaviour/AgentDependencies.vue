<script setup lang="ts">
import type { DependencyFreshness } from "@intentic/sandbox-contract";
import { formatDateTime, Icon, Row, RowGroup, SegmentedControl, StatusBadge, timeAgo, Verdict } from "@intentic/ui";
import { computed } from "vue";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useSavings } from "../../usage/useSavings";

/* WHAT THE ASSISTANT REACHES FOR WHEN IT ADDS A DEPENDENCY, and whether anything checks the version it picked
 * before it lands.
 *
 * It belongs in this group rather than beside the code-search rows because it is about the same moment those
 * are: the assistant is working, it needs a fact, and the question is whether it looks the fact up or recalls
 * it. Search is that question about the project's own code; this is it about everything the project depends
 * on, where a recalled answer carries the publication date of the model rather than of the registry. */

const { settings, patch } = useSandboxSettings();
const { savings } = useSavings({});

// Named for what each one is allowed to SAY, because that is the only difference between them and the user is
// choosing how much opinion they want, not how hard it tries.
const freshnessOptions = [
    { label: `Off`, value: `off` },
    { label: `Versions`, value: `versions` },
    { label: `Alternatives`, value: `full` },
];

const dependencySavings = computed(() => savings.value?.dependencies);

const verdict = computed(() => {
    const data = dependencySavings.value;
    if (data === undefined || data.checked === 0) {
        return {
            value: `Nothing yet`,
            unit: `no dependencies checked so far`,
            tone: `muted` as const,
            detail: `Checked when the assistant adds or modifies dependencies in manifests and install commands.`,
            evidence: ``,
        };
    }
    const ratio = `${data.improved} of ${data.checked} pins improved`;
    return {
        value: `${data.improved}`,
        unit: `improvements made (${ratio})`,
        tone: data.improved > 0 ? (`success` as const) : (`content` as const),
        detail: `prevented outdated or deprecated choices in favor of newer releases or maintained replacements`,
        evidence: data.updatedAt === undefined ? `` : `last check ${timeAgo(data.updatedAt)}`,
    };
});
</script>

<template>
    <RowGroup label="Dependencies">
        <Row
            spine
            icon="box"
            title="Check versions against the registry"
            description="Look up a version before it is pinned, instead of recalling one."
        >
            <template #control>
                <SegmentedControl
                    :model-value="settings?.dependencyFreshness ?? `off`"\
                    :options="freshnessOptions"
                    @update:model-value="(dependencyFreshness: string) => patch({ dependencyFreshness: dependencyFreshness as DependencyFreshness })"
                />
            </template>
            <!-- One line per state, saying what changes rather than repeating the label. The middle and right
                 states differ in KIND, not in strength: one reports what a registry publishes, the other adds
                 a judgement about which package to reach for, and a user picking between them deserves to be
                 told that is the difference. -->
            <template #below>
                <div class="flex flex-col gap-3">
                    <p v-if="settings?.dependencyFreshness === `versions`" class="text-2xs text-muted">
                        Facts only: whether a newer release exists, and whether the version picked is deprecated. The assistant is told and
                        decides — matching a version this workspace already uses stays a good answer.
                    </p>
                    <p v-else-if="settings?.dependencyFreshness === `full`" class="text-2xs text-muted">
                        The same facts, plus the name of a maintained replacement where a package is being added that has one. Suggestions are
                        made only as a package is added, never about one already in a manifest.
                    </p>
                    <p v-else class="text-2xs text-muted">Nothing is looked up, and no registry is contacted.</p>

                    <!-- Measured improvements readout, matching the style of Output savings on this view -->
                    <template v-if="settings?.dependencyFreshness !== `off`">
                        <Verdict
                            :value="verdict.value"
                            :unit="verdict.unit"
                            :tone="verdict.tone"
                            :detail="verdict.detail"
                            :evidence="verdict.evidence"
                        />

                        <!-- Recent improvements list -->
                        <div v-if="dependencySavings !== undefined && dependencySavings.recent.length > 0" class="flex flex-col gap-1.5 pt-1">
                            <p class="text-2xs font-medium uppercase tracking-wide text-subtle">Recent improvements</p>
                            <div
                                v-for="item in dependencySavings.recent.slice(0, 5)"
                                :key="`${item.prevented}->${item.chosen}`"
                                class="flex flex-col gap-0.5 rounded border border-line/40 bg-surface-subtle/30 px-2.5 py-1.5 text-2xs"
                            >
                                <div class="flex items-center justify-between gap-2">
                                    <span class="flex items-center gap-1.5 min-w-0">
                                        <span class="font-mono line-through text-danger/80 truncate">{{ item.prevented }}</span>
                                        <Icon name="arrow-right" class="shrink-0 text-3xs text-subtle" />
                                        <span class="font-mono text-success font-medium truncate">{{ item.chosen }}</span>
                                    </span>
                                    <span v-if="item.at !== undefined" class="shrink-0 text-3xs text-subtle" :title="formatDateTime(item.at)">
                                        {{ timeAgo(item.at) }}
                                    </span>
                                </div>
                                <p class="text-3xs text-muted leading-tight truncate" :title="item.reason">{{ item.reason }}</p>
                            </div>
                        </div>
                    </template>
                </div>
            </template>
        </Row>
    </RowGroup>
</template>
