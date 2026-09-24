<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { CONNECT_LANES } from "../../../connect/connectLanes";
import { endpointProviders, trialStatus } from "../../accounts/providerCatalog";
import { accessKnown, providerReady } from "../../session/access";

const t = useT();

const props = defineProps<{
    // Nothing is picked that could answer this chat.
    unset: boolean;
    onTrial: boolean;
    providerName: string;
}>();

// Only a sandbox with nothing but the trial is offered a way off it; past half the allowance the trial strip says it instead.
const offerUncapped = computed(
    () =>
        props.onTrial &&
        accessKnown.value &&
        trialStatus.value.available &&
        trialStatus.value.remaining > trialStatus.value.allowance / 2 &&
        !endpointProviders.value.some((endpoint) => endpoint.kind === `localmodel`) &&
        !CONNECT_LANES.some((lane) => lane.providers.some(providerReady)),
);
</script>

<template>
    <div class="m-auto flex max-w-[80%] flex-col items-center gap-3 text-center">
        <p class="text-xs text-muted">
            {{
                unset
                    ? t(`chat.chatPane.startConversationAny`)
                    : onTrial
                      ? t(`chat.chatPane.askAnythingChatFree`)
                      : t(`chat.chatPane.startConversation`, { providerName })
            }}
        </p>
        <p v-if="offerUncapped" class="max-w-[22rem] text-2xs leading-relaxed text-subtle">
            {{ t(`chat.chatPane.uncappedQuestion`) }}
            <RouterLink to="/connect" class="whitespace-nowrap text-link hover:underline">{{ t(`chat.chatPane.uncappedLink`) }}</RouterLink>
        </p>
    </div>
</template>
