<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import { Section } from "@intentic/ui";
import { computed } from "vue";
import type { ExtensionEntry } from "../../extensions/useExtensionList";
import { useT } from "@intentic/ui/i18n";

// What an installed extension is, the facts nobody opens its page for but someone checks now and then: which build, from
// where, what it adds, and what switching it off would not reach at once. Docked beside the page on a wide pane, where
// a reader glances at it; drawn at the foot on a narrow one. A column of quiet labels and plain values, no table rules.

const t = useT();

const { entry } = defineProps<{ entry: ExtensionEntry }>();

const manifest = computed(() => entry.extension.manifest);
const workspaceDir = computed(() => `.intentic/config/workspace-extensions/${manifest.value.name}`);

// Where the running code comes from, in words, with the one identifier that pins it down under them.
const source = computed<{ words: string; mark?: string }>(() => {
    if (entry.extension.source === `builtin`) {
        return { words: t(`sandbox.extensionRow.sourceBuiltin`) };
    }
    if (entry.extension.source === `workspace`) {
        return { words: t(`sandbox.extensionRow.sourceWorkspace`), mark: workspaceDir.value };
    }
    return { words: t(`sandbox.extensionRow.sourceInstalled`), mark: entry.extension.commit.slice(0, 12) };
});

// What it adds; settings are left out, since the page renders them as the controls they are.
const contributes = computed(() => entry.facets.filter((facet) => facet.kind !== `settings`));

// What flipping the switch doesn't reach immediately; stated before the flip rather than on every closed row.
const deferredNote = (kind: string): string[] => {
    switch (kind) {
        case `agent`:
            return [t(`sandbox.extensionRow.deferredAgent`)];
        case `bin`:
            return [t(`sandbox.extensionRow.deferredBin`)];
        case `environment`:
            return [t(`sandbox.extensionRow.deferredEnvironment`)];
        default:
            return [];
    }
};
const consequences = computed<string[]>(() => {
    if (!entry.extension.enabled) {
        return [];
    }
    const deferred = Object.keys(manifest.value.contributes ?? {}).flatMap(deferredNote);
    if (entry.dependents.length === 0) {
        return deferred;
    }
    const named = entry.dependents.map((capability) => capability.id).join(`, `);
    const count = entry.dependents.length;
    // Switching off only hides their card; removing takes the entries themselves, which is the dialog's job to say.
    return [...deferred, t(`sandbox.extensionRow.dependentsLoseCard`, { count, names: named }, count)];
});
</script>

<template>
    <Section :label="t(`sandbox.extensionRow.details`)" :heading="3">
        <dl class="flex flex-col gap-2.5 text-sm">
            <div class="flex gap-3">
                <dt class="w-24 shrink-0 text-xs leading-5 text-subtle">{{ t(`sandbox.extensionRow.detailVersion`) }}</dt>
                <dd class="min-w-0 text-content">v{{ manifest.version }}</dd>
            </div>
            <div class="flex gap-3">
                <dt class="w-24 shrink-0 text-xs leading-5 text-subtle">{{ t(`sandbox.extensionRow.detailSource`) }}</dt>
                <dd class="min-w-0 text-content">
                    {{ source.words }}
                    <span v-if="source.mark" class="block break-all font-mono text-2xs text-muted">{{ source.mark }}</span>
                </dd>
            </div>
            <div class="flex gap-3">
                <dt class="w-24 shrink-0 text-xs leading-5 text-subtle">{{ t(`sandbox.extensionRow.detailRequires`) }}</dt>
                <dd class="min-w-0 text-content">{{ t(`sandbox.extensionRow.requiresApp`, { range: manifest.engines.intentic }) }}</dd>
            </div>
            <div class="flex gap-3">
                <dt class="w-24 shrink-0 text-xs leading-5 text-subtle">{{ t(`sandbox.extensionRow.detailId`) }}</dt>
                <dd class="min-w-0 break-all font-mono text-xs leading-5 text-muted">{{ extensionIdOf(manifest) }}</dd>
            </div>
            <!-- Names wrap as a list of their own, one gap apart, rather than one run of text strung on dots. -->
            <div v-for="facet in contributes" :key="`${facet.kind}:${facet.label}`" class="flex gap-3">
                <dt class="w-24 shrink-0 text-xs leading-5 text-subtle first-letter:uppercase">{{ facet.label }}</dt>
                <dd class="min-w-0">
                    <ul
                        v-if="facet.names.length > 0"
                        class="flex flex-wrap gap-x-2.5 gap-y-0.5 text-content"
                        :class="facet.kind === `viewers` || facet.kind === `files` ? `break-all font-mono text-xs leading-5` : ``"
                    >
                        <li v-for="name in facet.names" :key="name">{{ name }}</li>
                    </ul>
                    <span v-else class="text-subtle">—</span>
                </dd>
            </div>
        </dl>

        <div v-if="consequences.length > 0" class="mt-4 flex flex-col gap-1">
            <p class="text-xs text-subtle">{{ t(`sandbox.extensionRow.whenSwitchedOff`) }}</p>
            <ul class="flex flex-col gap-0.5 text-xs leading-relaxed text-muted">
                <li v-for="consequence in consequences" :key="consequence" class="first-letter:uppercase">{{ consequence }}.</li>
            </ul>
        </div>
    </Section>
</template>
