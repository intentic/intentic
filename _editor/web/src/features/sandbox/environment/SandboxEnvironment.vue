<script setup lang="ts">
import { Await, RowGroup, RowNote, ui } from "@intentic/ui";
import { computed } from "vue";
import { useEnvironment } from "../../../models/sandbox/environment/useEnvironment";
import EnginesCard from "./EnginesCard.vue";
import EnvironmentCard from "./EnvironmentCard.vue";
import EnvironmentContentsOutline from "./EnvironmentContentsOutline.vue";
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
            <!-- Until it has been seen once: the card an applied environment draws, its header with the view switch, badge and
                 refresh as blocks (they read the overlay), over the contents' own outline. -->
            <template #fallback>
                <div role="status" aria-busy="true" :aria-label="t(`sandbox.sandboxEnvironment.readingSandboxsEnvironment`)">
                    <RowGroup :label="t(`sandbox.words.environment`)">
                        <template #actions>
                            <span class="flex items-center justify-end gap-2" aria-hidden="true">
                                <span class="skeleton block h-7 w-32 rounded-md" />
                                <span class="skeleton block h-5 w-16 rounded-full" />
                                <span class="skeleton block size-5" />
                            </span>
                        </template>
                        <RowNote variant="block">
                            <EnvironmentContentsOutline />
                        </RowNote>
                    </RowGroup>
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
