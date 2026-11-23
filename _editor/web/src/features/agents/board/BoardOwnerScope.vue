<!-- Whose sessions the board shows (AgentsView's header): Everyone, Mine, or one other person's. Pills while the header
     has room for them all; a picker naming the one chosen on a slim board (boardGrid.ts `CardFit`), where the pills ran
     past the board's edge and pushed the filter out of sight. -->
<script setup lang="ts">
import { Picker, SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { ownerSegments } from "../../../models/fleet/board/boardScope";

defineProps<{
    options: ReturnType<typeof ownerSegments>;
    // A slim board folds the pills into the picker; a phone wraps them instead.
    folded: boolean;
    mobile: boolean;
}>();
const scope = defineModel<string>({ required: true });

const t = useT();
</script>

<template>
    <Picker v-if="folded" v-model="scope" :options="options" variant="ghost" :aria-label="t(`agents.agentsView.whoseSessions`)" class="min-w-0" />
    <SegmentedControl v-else v-model="scope" :options="options" size="xs" :wrap="mobile" class="max-w-full" />
</template>
