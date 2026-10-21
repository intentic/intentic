<!-- What an owner's removal takes along and what it promises back, under the dialog's one line: the takings as words, the promise as the dialog's one mark. -->
<script setup lang="ts">
import { SANDBOX_RECOVERY_DAYS as RECOVERY_DAYS } from "@intentic/api-contract";
import { SectionHeader, toneWash } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { removalTakes } from "../switcherRows";

const t = useT();

/** A hosted machine keeps its disk until the restore window ends; a box of the reader's own comes back at a new address. */
const { hosted } = defineProps<{ hosted: boolean }>();
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- What the reader set up lives in the sandbox, not the account, so it leaves with it (switcherRows.ts). -->
        <section class="@container flex flex-col gap-2.5">
            <SectionHeader :label="t(`sandbox.removeAsk.goesWithIt`)" tone="danger" density="dense" />
            <ul class="grid grid-cols-1 gap-2 @md:grid-cols-3 @md:gap-4">
                <!-- Words only: three marks here beside the promise's one below made the dialog a wall of icons. -->
                <li v-for="item in removalTakes(`owner`)" :key="item.icon" class="flex min-w-0 flex-col">
                    <span class="font-medium text-content">{{ item.label }}</span>
                    <span class="text-xs text-subtle">{{ item.note }}</span>
                </li>
            </ul>
        </section>

        <!-- The promise the deletion makes. The lanes differ in what comes back: a hosted machine keeps its disk,
             an own-machine sandbox comes back as a name with a new address. -->
        <div class="flex items-start gap-2.5">
            <span :class="toneWash(`success`, `grid size-8 shrink-0 place-items-center rounded-lg`)">
                <Icon name="history" />
            </span>
            <span class="flex min-w-0 flex-col">
                <span class="flex flex-wrap items-baseline gap-x-1.5">
                    <span class="font-medium text-content">{{ t(`sandbox.removeAsk.restorable`, { count: RECOVERY_DAYS }, RECOVERY_DAYS) }}</span>
                    <span class="text-subtle">{{ t(`sandbox.removeAsk.restoreFrom`) }}</span>
                </span>
                <span class="text-xs text-subtle">
                    {{ hosted ? t(`sandbox.removeAsk.restoreHostedKept`) : t(`sandbox.removeAsk.restoreOwnCatch`) }}
                </span>
            </span>
        </div>
    </div>
</template>
