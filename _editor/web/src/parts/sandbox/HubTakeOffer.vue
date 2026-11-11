<!-- "Use one saved on your computer": asks the owner's computers for a connection saved there from another of their sandboxes, and says what they answered. -->
<script setup lang="ts">
import type { HubWant } from "@intentic/sandbox-contract/schemas/connection-hub";
import { Button, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useConnectionHub } from "../../models/hub/useConnectionHub";

// The alternative to filling a form in or signing in again, never instead of it: nothing says the computer holds one of
// these until it is asked, so the press is the boring tier beside whatever the surface is open for. The computer asks its
// person which one to share; the answer is the sandbox's own sentence (shared, waiting for that yes, or nothing there
// answers it), and a connection made from it shows up in the list it belongs to.

const t = useT();

const { want, disabled = false } = defineProps<{
    want: HubWant;
    // Another press on the same surface is on its way (a sign-in starting).
    disabled?: boolean;
}>();

const { offered, take, takeOf, dismissTake } = useConnectionHub();
const taking = computed(() => takeOf(want));
</script>

<template>
    <!-- Only while some computer could answer: with none connected and set up, the press could only be refused. -->
    <div v-if="offered" class="flex flex-col items-start gap-1.5">
        <Button tier="boring" size="small" :label="t(`sandbox.connectionHub.useSaved`)" :loading="taking.busy" :disabled="disabled" @click="take(want)">
            <template #icon><Icon name="desktop" /></template>
        </Button>
        <p v-if="taking.answer" class="flex items-center gap-1.5 text-xs" :class="taking.answer.outcome === `taken` ? `text-success` : `text-muted`">
            <Icon v-if="taking.answer.outcome === `taken`" name="check" class="shrink-0" />
            {{ taking.answer.message }}
        </p>
        <Notice v-if="taking.failure" :of="taking.failure" size="sm" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="dismissTake(want)" />
    </div>
</template>
