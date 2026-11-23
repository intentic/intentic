<script setup lang="ts">
import { ROW_BLOCK_PAD, Row, useRowDensity } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// A connection not added yet, drawn as the open row it will become: the same head and its form under one rule, at the
// top of the list where Add put it. Not a <DisclosureRow>: it has nothing to fold, and a stray press on its head must
// not close it and throw away what was typed. The head previews the name being typed into the form below, so what is
// being made is visible before it exists.

const t = useT();

defineProps<{
    /** The name the connection will be saved under, as the form below repairs it; empty until there is one. */
    name: string;
}>();

const tier = useRowDensity(() => undefined);
</script>

<template>
    <div data-capability-draft>
        <Row>
            <!-- A dot with no state yet, where a saved row shows whether it works. -->
            <template #lead><span class="h-1.5 w-1.5 shrink-0 rounded-full border border-line-strong" aria-hidden="true" /></template>
            <template #title>
                <span v-if="name" class="font-mono">{{ name }}</span>
                <span v-else class="text-muted">{{ t(`capabilities.capabilityDraftRow.newConnection`) }}</span>
            </template>
            <template #meta>{{ t(`capabilities.capabilityDraftRow.notAddedYet`) }}</template>
        </Row>
        <div class="border-t border-line-subtle" :class="ROW_BLOCK_PAD[tier]">
            <slot />
        </div>
    </div>
</template>
