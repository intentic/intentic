<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";

// WHAT A REDIRECT SIGN-IN'S LAST PAGE LOOKS LIKE: a browser window on the loopback address the provider sent it to, which
// cannot load. Reference, never an instruction: a thumbnail beside the one sentence it illustrates, inert so a press on
// it is not swallowed by a picture (a full-size one, wearing the emphasis ring, was pressed in a recorded session).

const t = useT();

// The address as the reader will see it in their own bar, a grant truncated like a real one since only the shape matters.
const { address } = defineProps<{ address: string }>();
</script>

<template>
    <div class="ui-enter pointer-events-none flex max-w-md items-center gap-3 select-none" aria-hidden="true">
        <div class="w-44 shrink-0 overflow-hidden rounded-lg border border-line bg-canvas">
            <div class="flex items-center gap-1.5 border-b border-line-subtle px-2 py-1.5">
                <span class="flex shrink-0 gap-1">
                    <span class="size-1.5 rounded-full bg-content/20"></span>
                    <span class="size-1.5 rounded-full bg-content/20"></span>
                    <span class="size-1.5 rounded-full bg-content/20"></span>
                </span>
                <span class="flex min-w-0 flex-1 items-center gap-1 rounded border border-line bg-overlay px-1 py-0.5">
                    <Icon name="unlock" class="shrink-0 text-[0.55rem] text-subtle" />
                    <span class="truncate font-mono text-[0.55rem] text-content">{{ address }}</span>
                </span>
            </div>
            <div class="flex flex-col items-center gap-1 px-3 py-3">
                <Icon name="globe" class="text-base text-content/20" />
                <span class="text-[0.6rem] text-subtle">{{ t(`sandbox.connectFlow.siteCantReached`) }}</span>
            </div>
        </div>
        <p class="text-muted">{{ t(`sandbox.connectFlow.copyAddressBar`) }}</p>
    </div>
</template>
