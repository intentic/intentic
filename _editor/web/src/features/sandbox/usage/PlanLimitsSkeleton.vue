<!-- Plan limits before the connections are read: the section under its real heading, the fleet-wide card beside provider cards. -->
<script lang="ts">
// The one grid both the panel and its skeleton stand on: provider cards on the left, the fleet-wide card on the right
// once the panel is wide enough for both. One string, so the outline cannot promise a column the panel never draws.
export const SPLIT = `grid gap-3 @2xl:grid-cols-[minmax(0,1fr)_16rem] @4xl:grid-cols-[minmax(0,1fr)_18rem]`;
</script>

<script setup lang="ts">
import { Card, Section } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// Drawn by PlanLimitsPanel until it has been seen once, and by Usage while its ledger is read, so the page below the tiles
// is promised as the panel it will be rather than as something else.

const t = useT();
</script>

<template>
    <Section class="@container" :label="t(`shared.planLimits`)" role="status" aria-busy="true" :aria-label="t(`sandbox.words.readingConnections`)">
        <div :class="SPLIT" aria-hidden="true">
            <Card class="flex flex-col gap-3 @2xl:col-start-2 @2xl:row-start-1">
                <div class="flex flex-col gap-1.5">
                    <span class="skeleton block h-4 w-44" />
                    <span class="skeleton block h-2.5 w-32" />
                </div>
                <!-- Matches the strip's actual height; a thicker placeholder would promise more than the real thing. -->
                <span class="skeleton block h-1.5 w-full rounded-full" />
                <div class="flex flex-wrap gap-x-3 gap-y-1.5 @2xl:flex-col">
                    <span v-for="(width, index) in [`w-20`, `w-24`, `w-16`]" :key="index" class="skeleton block h-2.5" :class="width" />
                </div>
            </Card>
            <!-- A provider's card: its mark and name, then an account's line over its window's meter. -->
            <div class="flex min-w-0 flex-col gap-3 @2xl:col-start-1 @2xl:row-start-1">
                <Card v-for="card in 2" :key="card" class="flex gap-2.5">
                    <span class="skeleton block size-5 shrink-0 rounded-md" />
                    <div class="flex min-w-0 flex-1 flex-col gap-3">
                        <span class="skeleton block h-3.5 w-28" />
                        <span class="flex justify-between gap-3"><span class="skeleton block h-2.5 w-40" /><span class="skeleton block h-2.5 w-20" /></span>
                        <span class="skeleton block h-1.5 w-full rounded-full" />
                    </div>
                </Card>
            </div>
        </div>
    </Section>
</template>
