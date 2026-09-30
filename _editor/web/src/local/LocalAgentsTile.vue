<script setup lang="ts">
import { AnchoredOverlay, Button, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, watch } from "vue";
import { type LocalFacts, localHost } from "../app/environments/localHost";

// THE FOOT OF A LOCAL WINDOW'S RAIL, where the sandbox shell keeps the account: the one thing an account adds here is
// agents, so that is what it offers. An install that has never signed in is told what agents need and offered the
// sign-in, which runs in the default browser and comes back as the workspace; one that has is offered the workspace
// itself, which takes this window's place (the app swaps the two in one frame). Nothing on this computer needs either.

const t = useT();
const host = localHost();

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

// Read on mount and whenever it opens: a sign-in finishing in the browser changes the answer while this window stays up.
const facts = ref<LocalFacts | undefined>(undefined);
const readFacts = async (): Promise<void> => {
    try {
        facts.value = await host.facts();
    } catch (error) {
        console.error(`[local] what this install knows could not be read:`, error);
    }
};
onMounted(() => void readFacts());
watch(open, (isOpen) => {
    if (isOpen) {
        failure.value = undefined;
        void readFacts();
    }
});

const signedIn = computed(() => facts.value?.accountSeen === true);
const label = computed(() => (signedIn.value ? t(`local.agentsTile.workspace`) : t(`local.agentsTile.putAgentsToWork`)));

// Signing in happens in the default browser, so this window's part ends when the browser opens; it says so rather
// than sitting there as if nothing had been pressed.
const handedOver = ref(false);
const failure = ref<string | undefined>(undefined);
const busy = ref(false);
const go = async (): Promise<void> => {
    if (busy.value) {
        return;
    }
    busy.value = true;
    failure.value = undefined;
    try {
        if (signedIn.value) {
            await host.openWorkspace();
            open.value = false;
        } else {
            await host.signIn();
            handedOver.value = true;
        }
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <button
        ref="trigger"
        type="button"
        class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
        :class="{ 'bg-primary-600/15 text-link': open }"
        :aria-label="label"
        :aria-expanded="open"
        v-tooltip.right="open ? undefined : label"
        @click="open = !open"
    >
        <Icon name="robot" class="icon-rail-glyph" />
    </button>

    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="right" cross="end">
        <div class="flex w-72 flex-col gap-3 p-3">
            <div class="flex items-start gap-2.5">
                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-600/15 text-link">
                    <Icon name="robot" class="text-base" />
                </span>
                <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold text-content">{{ label }}</p>
                    <p class="mt-0.5 text-xs text-muted">
                        {{ signedIn ? t(`local.agentsTile.workspaceLead`) : handedOver ? t(`local.agentsTile.finishInBrowser`) : t(`local.agentsTile.agentsLead`) }}
                    </p>
                </div>
            </div>
            <Button
                :label="signedIn ? t(`local.agentsTile.openWorkspace`) : t(`ui.action.signIn`)"
                :loading="busy"
                size="small"
                class="w-full"
                @click="go"
            >
                <template #icon><Icon :name="signedIn ? `arrow-up-right` : `sign-in`" /></template>
            </Button>
            <Notice v-if="failure" tone="danger" class="text-2xs">{{ failure }}</Notice>
            <!-- What a reader who only came for their files needs to hear: nothing here depends on this. -->
            <p v-if="!signedIn" class="flex items-start gap-1.5 text-2xs text-subtle">
                <Icon name="lock" class="mt-px shrink-0" />
                <span>{{ t(`local.agentsTile.filesStayHere`) }}</span>
            </p>
        </div>
    </AnchoredOverlay>
</template>
