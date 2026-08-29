<script setup lang="ts">
import type { DependencyFreshness } from "@intentic/sandbox-contract";
import { Row, RowGroup, SegmentedControl } from "@intentic/ui";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";

/* WHAT THE ASSISTANT REACHES FOR WHEN IT ADDS A DEPENDENCY, and whether anything checks the version it picked
 * before it lands.
 *
 * It belongs in this group rather than beside the code-search rows because it is about the same moment those
 * are: the assistant is working, it needs a fact, and the question is whether it looks the fact up or recalls
 * it. Search is that question about the project's own code; this is it about everything the project depends
 * on, where a recalled answer carries the publication date of the model rather than of the registry. */

const { settings, patch } = useSandboxSettings();

// Named for what each one is allowed to SAY, because that is the only difference between them and the user is
// choosing how much opinion they want, not how hard it tries.
const freshnessOptions = [
    { label: `Off`, value: `off` },
    { label: `Versions`, value: `versions` },
    { label: `Alternatives`, value: `full` },
];
</script>

<template>
    <RowGroup label="Dependencies">
        <Row
            icon="box"
            title="Check versions against the registry"
            description="Look up a version before it is pinned, instead of recalling one."
        >
            <template #control>
                <SegmentedControl
                    :model-value="settings?.dependencyFreshness ?? `off`"
                    :options="freshnessOptions"
                    @update:model-value="(dependencyFreshness: string) => patch({ dependencyFreshness: dependencyFreshness as DependencyFreshness })"
                />
            </template>
            <!-- One line per state, saying what changes rather than repeating the label. The middle and right
                 states differ in KIND, not in strength: one reports what a registry publishes, the other adds
                 a judgement about which package to reach for, and a user picking between them deserves to be
                 told that is the difference. -->
            <template #below>
                <p v-if="settings?.dependencyFreshness === `versions`" class="text-2xs text-muted">
                    Facts only: whether a newer release exists, and whether the version picked is deprecated. The assistant is told and
                    decides — matching a version this workspace already uses stays a good answer.
                </p>
                <p v-else-if="settings?.dependencyFreshness === `full`" class="text-2xs text-muted">
                    The same facts, plus the name of a maintained replacement where a package is being added that has one. Suggestions are
                    made only as a package is added, never about one already in a manifest.
                </p>
                <p v-else class="text-2xs text-muted">Nothing is looked up, and no registry is contacted.</p>
            </template>
        </Row>
    </RowGroup>
</template>
