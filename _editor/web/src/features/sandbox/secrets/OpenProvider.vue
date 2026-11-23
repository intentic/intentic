<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { Button, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";

// THE WAY TO A SIGN-IN'S PAGE, in either of its two weights: the step's one button while going there is what the reader
// has to do (accent, the provider's mark on it), and a quiet link once they have gone, to reopen a page they closed. A
// link either way, so the browser opens it in the press itself, severed from this page.

const t = useT();

const { url, provider, destination, again = false } = defineProps<{ url: string; provider: AgentProvider; destination: string; again?: boolean }>();
const emit = defineEmits<{ open: [event: Event] }>();
</script>

<template>
    <a v-if="again" :class="ui.textButton({ size: `xs` })" :href="url" target="_blank" rel="noopener" @click="emit(`open`, $event)">
        {{ t(`sandbox.connectFlow.openAgain`) }}<Icon name="external-link" />
    </a>
    <Button v-else tier="accent" as="a" class="touch-target" :href="url" target="_blank" rel="noopener" @click="emit(`open`, $event)">
        <ProviderLogo :provider="provider" />{{ t(`ui.action.open`) }} {{ destination }}<Icon name="external-link" />
    </Button>
</template>
