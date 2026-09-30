<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import type { ChainLink, LinkState } from "./presentation";

// THE CHAIN a request to a sandbox travels, drawn as the diagnosis found it: this device, the network to Intentic, the
// machine the sandbox runs on, the sandbox. One glance says which link broke, so the sentence above it never has to
// explain the whole path, and a reader who was told "it's busy" can see that everything up to the sandbox is fine.

defineProps<{ readonly links: readonly ChainLink[] }>();

const t = useT();

const DOT = { ok: `bg-success`, down: `bg-danger`, working: `bg-info`, unknown: `bg-subtle` } as const satisfies Record<LinkState, string>;
const stateWord = (state: LinkState): string => {
    switch (state) {
        case `ok`:
            return t(`sandbox.diagnosis.linkOk`);
        case `down`:
            return t(`sandbox.diagnosis.linkDown`);
        case `working`:
            return t(`sandbox.diagnosis.linkWorking`);
        case `unknown`:
            return t(`sandbox.diagnosis.linkUnknown`);
    }
};
</script>

<template>
    <ol class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted" :aria-label="t(`sandbox.diagnosis.chainLabel`)">
        <li v-for="(link, index) in links" :key="link.id" class="flex min-w-0 items-center gap-1.5">
            <span v-if="index > 0" class="h-px w-3 bg-line" aria-hidden="true" />
            <Icon v-if="link.state === `working`" name="spinner" spin class="size-3 shrink-0 text-info" aria-hidden="true" />
            <span v-else class="size-2 shrink-0 rounded-full" :class="DOT[link.state]" aria-hidden="true" />
            <span class="truncate" :class="{ 'font-medium text-content': link.state === `down` }">{{ link.label }}</span>
            <span class="sr-only">{{ stateWord(link.state) }}</span>
        </li>
    </ol>
</template>
