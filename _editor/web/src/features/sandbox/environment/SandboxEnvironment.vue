<script setup lang="ts">
import { Await, ui } from "@intentic/ui";
import { computed } from "vue";
import { useEnvironment } from "../../../models/sandbox/environment/useEnvironment";
import EnginesCard from "./EnginesCard.vue";
import EnvironmentCard from "./EnvironmentCard.vue";
import ExportCard from "../access/ExportCard.vue";
import ImportCard from "../access/ImportCard.vue";
import { useT } from "@intentic/ui/i18n";

// The Sandbox hub's Environment tab: what this sandbox is (overlay, engines), then moving it. Moving is split by
// direction (out/in), not by artifact, since each artifact is a choice inside a direction rather than its own card.
// The overlay sits above both, since a bundle's last step is the rebuild it hands you.

const t = useT();

const { proposal, pending, applied, loaded } = useEnvironment();
const empty = computed(() => !proposal.value && !pending.value && !applied.value);
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- The card draws nothing until the overlay is read, and the empty-state sentence must not speak for an unread one:
             both wait as they last looked in this sandbox, as a card's shape before either has been seen. -->
        <Await :of="loaded" imprint="sandbox.environment.overlay" :label="t(`sandbox.sandboxEnvironment.readingSandboxsEnvironment`)">
            <EnvironmentCard />
            <div v-if="empty" :class="ui.emptyState('py-10')">{{ t(`sandbox.sandboxEnvironment.noEnvironmentChangesYet`) }}</div>
            <template #fallback>
                <div role="status" aria-busy="true" class="flex flex-col gap-3 rounded-lg bg-card shadow-sm p-4">
                    <span class="sr-only">{{ t(`sandbox.sandboxEnvironment.readingSandboxsEnvironment`) }}</span>
                    <span class="skeleton block h-3.5 w-44" aria-hidden="true" />
                    <div class="flex flex-col gap-2" aria-hidden="true">
                        <span
                            v-for="(width, index) in [`w-3/4`, `w-1/2`, `w-5/6`, `w-2/5`]"
                            :key="index"
                            class="skeleton block h-2.5"
                            :class="width"
                        />
                    </div>
                </div>
            </template>
        </Await>

        <!-- The environment row sits below the overlay and separates installed from available states. -->
        <EnginesCard />

        <!-- Out is drawn first: that's the one an owner reaches for while still holding this sandbox. -->
        <ExportCard />
        <ImportCard />
    </div>
</template>
