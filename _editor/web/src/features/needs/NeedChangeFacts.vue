<!-- A change to a connection's settings, one setting to a line, in its form's own words: "Use the mouse and keyboard
     Blocked → Allowed" rather than `control` `off` → `on`. An open card knows what each was; a closed one says only what it
     is now, since the connection already holds the new value. -->
<script setup lang="ts">
import type { CapabilityNeed } from "@intentic/sandbox-contract/schemas/needs";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { computed } from "vue";
import { coreFieldWords } from "../../models/capabilities/catalogCopy";
import { catalogEntries } from "../../models/capabilities/tiles";
import { useCapabilities } from "../../models/capabilities/useCapabilities";
import { useExtensions } from "../../models/extensions/useExtensions";
import { settingChanges } from "./settingChanges";

const { subject, current = undefined } = defineProps<{ subject: CapabilityNeed; current?: CapabilitySummary[`config`] | undefined }>();

const { capabilities } = useCapabilities();
const { enabled } = useExtensions();
// The tile's own fields; failing that, the ones every connection of its kind carries (a device's switches), since a tile
// whose extension was switched off since still leaves the connection holding them.
const fields = computed(() => {
    const entry = catalogEntries(enabled.value, capabilities.value).find((candidate) => candidate.id === subject.entry);
    if (entry !== undefined) {
        return entry.fields;
    }
    const kind = capabilities.value.find((capability) => capability.id === subject.instance)?.kind;
    return kind === undefined ? [] : coreFieldWords(kind);
});
const changes = computed(() => settingChanges(fields.value, subject.changes, current));
</script>

<template>
    <span v-for="change in changes" :key="change.key" class="inline-flex min-w-0 flex-wrap items-center gap-x-1.5" data-setting-change>
        <span class="text-muted">{{ change.label }}</span>
        <template v-if="change.from !== undefined && change.from !== change.to">
            <span class="text-subtle" :class="{ 'font-mono': change.raw }">{{ change.from }}</span>
            <Icon name="arrow-right" class="text-2xs text-subtle" aria-hidden="true" />
        </template>
        <span class="font-medium text-content" :class="{ 'font-mono': change.raw }">{{ change.to }}</span>
    </span>
</template>
