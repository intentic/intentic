<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { NATIVE_PROVIDERS, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { endpointProviders } from "../../accounts/providerCatalog";
import { accessKnown, providerReady, trialPhase } from "../../session/access";
import { MODELS_PATH } from "../../../../lib/routes/modelsPath";

const t = useT();

const props = defineProps<{
    // Nothing is picked that could answer this chat.
    unset: boolean;
    onTrial: boolean;
    providerName: string;
    // Plain words (a non-coder, a guest): the assistant, never the coding tool behind it, and no offer to change models.
    plain?: boolean;
}>();

// Only a sandbox with nothing but the trial is offered a way off it, while the trial is fresh; past that the trial strip
// says it instead (trialPhase, the one reading of the allowance).
const offerUncapped = computed(
    () =>
        props.plain !== true &&
        props.onTrial &&
        accessKnown.value &&
        trialPhase(TRIAL_PROVIDER) === `fresh` &&
        !endpointProviders.value.some((endpoint) => endpoint.kind === `localmodel`) &&
        !NATIVE_PROVIDERS.some(providerReady),
);
</script>

<template>
    <div class="m-auto flex max-w-[80%] flex-col items-center gap-3 text-center">
        <p class="text-xs text-muted">
            {{
                unset
                    ? t(`chat.chatPane.startConversationAny`)
                    : plain
                      ? t(`chat.chatPane.plain.startConversation`)
                      : onTrial
                      ? t(`chat.chatPane.askAnythingChatFree`)
                      : t(`chat.chatPane.startConversation`, { providerName })
            }}
        </p>
        <p v-if="offerUncapped" class="max-w-[22rem] text-2xs leading-relaxed text-subtle">
            {{ t(`chat.chatPane.uncappedQuestion`) }}
            <RouterLink :to="MODELS_PATH" class="touch-target whitespace-nowrap text-link hover:underline">{{
                t(`chat.chatPane.uncappedLink`)
            }}</RouterLink>
        </p>
    </div>
</template>
