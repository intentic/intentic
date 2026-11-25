<script setup lang="ts">
import { Row, RowGroup, RowNote } from "@intentic/ui";
import { computed } from "vue";
import type { ExtensionFacet } from "../../../extensions/extensionFacets";
import type { ExtensionEntry } from "../../../extensions/useExtensionList";
import SurfacePictogram from "./SurfacePictogram.vue";
import { useT } from "@intentic/ui/i18n";

// What an installed extension adds, by the names a reader will meet it under, each drawn as where in the editor it
// lands: the "Deployments" tile on the rail, the "Komodo" card among the capabilities. Settings are left out, since the
// page renders them as the controls they are. Under them, what switching it off would not reach at once, said before
// the flip rather than after it.

const t = useT();

const { entry } = defineProps<{ entry: ExtensionEntry }>();

const places = computed(() => entry.facets.filter((facet) => facet.kind !== `settings`));

const capitalized = (words: string): string => words.charAt(0).toLocaleUpperCase() + words.slice(1);
// The names lead where it has them; the kind of place is the line under. A kind with no names is its own title.
const titleOf = (facet: ExtensionFacet): string => (facet.names.length === 0 ? capitalized(facet.label) : facet.names.join(`, `));
const placeOf = (facet: ExtensionFacet): string | undefined => (facet.names.length === 0 ? undefined : capitalized(facet.label));

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
    const deferred = Object.keys(entry.extension.manifest.contributes ?? {}).flatMap(deferredNote);
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
    <RowGroup v-if="places.length > 0" id="extension-places" :label="t(`sandbox.extensionRow.showsUpIn`)">
        <Row v-for="facet in places" :key="`${facet.kind}:${facet.label}`" :title="titleOf(facet)" :description="placeOf(facet)">
            <template #lead><SurfacePictogram :place="facet.place ?? facet.kind" /></template>
        </Row>
        <RowNote v-if="consequences.length > 0" icon="info-circle">
            <span class="font-medium">{{ t(`sandbox.extensionRow.whenSwitchedOff`) }}:</span>
            {{ consequences.map(capitalized).join(`. `) }}.
        </RowNote>
    </RowGroup>
</template>
