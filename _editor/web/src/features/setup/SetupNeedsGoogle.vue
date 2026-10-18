<!-- The free machine's three ways on for an account that signs in only by email: link Google, buy a machine, or run here. -->
<script setup lang="ts">
import { Button, vAction } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useAuth } from "../../client/auth/useAuth";

// Drawn in place of the hosted rung's button while the free machine needs Google linked first (Setup.vue's
// `hostedNeedsGoogle`). `chooseMine` is the own-computer rung's press, absent where the ladder offers no such rung.
const t = useT();
const route = useRoute();
const { linkGoogle } = useAuth();

const { chooseMine } = defineProps<{ chooseMine?: () => Promise<void> }>();

const linkingGoogle = ref(false);
const linkGoogleError = ref<string>();
// Google's page, then back to this setup with the account able to take the free machine.
const linkGoogleHere = async (): Promise<void> => {
    linkingGoogle.value = true;
    linkGoogleError.value = undefined;
    try {
        await linkGoogle(route.fullPath);
    } catch (refusal) {
        linkGoogleError.value = refusal instanceof Error ? refusal.message : t(`auth.useAuth.linkGoogleFailed`);
        linkingGoogle.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-2 text-left" role="note">
        <p class="text-xs leading-snug text-muted">{{ t(`setup.setup.needsGoogleDetail`) }}</p>
        <div class="flex flex-wrap gap-2">
            <Button :label="t(`setup.setup.linkGoogle`)" size="small" :loading="linkingGoogle" @click="linkGoogleHere">
                <template #icon><Icon name="google" /></template>
            </Button>
            <Button :as="RouterLink" to="/settings/billing" :label="t(`setup.setup.buyMachine`)" size="small" tier="boring">
                <template #icon><Icon name="credit-card" /></template>
            </Button>
            <Button v-if="chooseMine" :label="t(`setup.setup.runOnThisComputer`)" size="small" tier="boring" v-action="chooseMine">
                <template #icon><Icon name="desktop" /></template>
            </Button>
        </div>
        <p v-if="linkGoogleError" class="text-xs text-danger">{{ linkGoogleError }}</p>
    </div>
</template>
