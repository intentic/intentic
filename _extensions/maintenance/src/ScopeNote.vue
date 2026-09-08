<script setup lang="ts">
import { type ChoreVerdict, probeSpec } from "@intentic/sandbox-contract/chores";
import { Icon, ui } from "@intentic/extension-ui";
import type { ProbeResult } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";

// What this repository was not asked, as a footnote read after the list rather than a banner before it; renders only
// when one repository is in view.
// not applicable: chore's subject doesn't exist here; dropped from the list entirely, so this is its only record.
// not measured: the probe cannot run here (no package.json, no lockfile, tool missing).
// failed: the probe ran and the tool broke, in its own words.

const { probes, inapplicable } = defineProps<{
    probes: readonly ProbeResult[];
    inapplicable: readonly ChoreVerdict[];
}>();

const open = ref(false);

// Groups by cause, one line each; insertion order, so causes come out in the book's order, not alphabetical.
const byCause = (entries: readonly { cause: string; name: string }[]): { cause: string; names: string[] }[] => {
    const groups = new Map<string, string[]>();
    for (const { cause, name } of entries) {
        groups.set(cause, [...(groups.get(cause) ?? []), name]);
    }
    return [...groups].map(([cause, names]) => ({ cause, names }));
};

const probesInState = (state: ProbeResult["state"]): { cause: string; names: string[] }[] =>
    byCause(
        probes.flatMap((probe) =>
            probe.state === state ? [{ cause: probe.reason ?? `not available in this repository`, name: probeSpec(probe.id).title.toLowerCase() }] : [],
        ),
    );

const unmeasured = computed(() => probesInState(`unavailable`));

// Kept separate from `unavailable`: a missing tool is a fact about the repo, a crashed one is something to go look at.
const failed = computed(() => probesInState(`failed`));

// Cause comes from the verdict's headline (verdict.ts), written as a bare clause for this grouping.
const ruledOut = computed(() => byCause(inapplicable.map((verdict) => ({ cause: verdict.headline, name: verdict.chore.title.toLowerCase() }))));

const total = (groups: { names: string[] }[]): number => groups.reduce((sum, group) => sum + group.names.length, 0);
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

// Always-visible summary; counts chores and measurements, not causes — a cause count would describe this component, not
// the page.
const summary = computed(() =>
    [
        inapplicable.length === 0 ? undefined : `${plural(inapplicable.length, `chore does`, `chores do`)} not apply here`,
        total(unmeasured.value) === 0 ? undefined : `${plural(total(unmeasured.value), `measurement`, `measurements`)} unavailable`,
        total(failed.value) === 0 ? undefined : `${plural(total(failed.value), `measurement`, `measurements`)} failed`,
    ]
        .filter((clause) => clause !== undefined)
        .join(` · `),
);

const blocks = computed(() =>
    [
        { label: `Not applicable`, groups: ruledOut.value },
        { label: `Not measured`, groups: unmeasured.value },
        { label: `Measurement failed`, groups: failed.value },
    ].filter((block) => block.groups.length > 0),
);
</script>

<template>
    <!-- No wash or outline: a panel here would read as a fifth kind group, not a note about the four above it. -->
    <div v-if="summary !== ``" class="border-t border-line/60 pt-3">
        <button type="button" :class="ui.textAction(`text-2xs text-subtle`)" :aria-expanded="open" @click="open = !open">
            <Icon :name="open ? `chevron-down` : `chevron-right`" class="text-2xs" />
            <span>{{ summary }}</span>
        </button>

        <!-- Cause on the left, cost on the right; separate blocks so a reader can tell which of the three answers applies. -->
        <!-- @container: columns split on this block's own width (the pane's), not the window's. -->
        <div v-if="open" class="@container flex flex-col gap-2 pt-1.5 pl-4">
            <div v-for="block in blocks" :key="block.label">
                <p class="text-2xs text-content">{{ block.label }}</p>
                <dl class="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 @md:grid-cols-facts">
                    <template v-for="group in block.groups" :key="group.cause">
                        <dt class="text-2xs text-subtle">{{ group.cause }}</dt>
                        <dd class="text-2xs text-subtle/70">{{ group.names.join(` · `) }}</dd>
                    </template>
                </dl>
            </div>
        </div>
    </div>
</template>
