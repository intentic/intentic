<script setup lang="ts">
import { AnchoredOverlay, Button, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, watch } from "vue";
import { type LocalFoundProvider, localHost } from "../app/environments/localHost";
import { foundSubscriptions, subscriptionName } from "./foundProjects";

// THE FOOT OF A LOCAL WINDOW'S RAIL BEFORE THERE IS AN ACCOUNT, where the sandbox shell keeps the account. Once there is
// one, the foot is the sandbox shell's own account control (shell/AccountPanel.vue, LocalShell.vue chooses). Until then,
// what agents need, and the sign-in that brings them: it runs in the default browser and comes back as the workspace.
// Nothing on this computer needs either. The subscriptions this computer's AI tools are signed in to (the app's found.rs)
// are named here, since they are what an account would put to work: the sandbox signs in to each on its own, from
// Connect, so the tools here keep their logins.

const t = useT();
const host = localHost();

const found = ref<readonly LocalFoundProvider[]>([]);
onMounted(async () => {
    if (!host.native) {
        return;
    }
    try {
        found.value = foundSubscriptions((await host.found()).providers);
    } catch (error) {
        // Naming them is a nicety: a computer that cannot be read leaves the tile as it was, and says why on the console.
        console.warn(`[local] what this computer's tools found could not be read`, error);
    }
});
const lead = computed(() =>
    found.value.length === 0
        ? t(`local.agentsTile.agentsLead`)
        : t(`local.agentsTile.foundLead`, { subscriptions: found.value.map(subscriptionName).join(`, `) }),
);

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const label = t(`local.agentsTile.putAgentsToWork`);

// Signing in happens in the default browser, so this window's part ends when the browser opens; it says so rather
// than sitting there as if nothing had been pressed.
const handedOver = ref(false);
const failure = ref<string | undefined>(undefined);
const busy = ref(false);
watch(open, (isOpen) => {
    if (isOpen) {
        failure.value = undefined;
    }
});
const signIn = async (): Promise<void> => {
    if (busy.value) {
        return;
    }
    busy.value = true;
    failure.value = undefined;
    try {
        await host.signIn();
        handedOver.value = true;
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <!-- No account yet: the one thing an account adds here, agents. -->
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

    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="right" cross="end" menu>
        <div class="flex w-72 flex-col gap-3 p-3">
            <div class="flex items-start gap-2.5">
                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-600/15 text-link">
                    <Icon name="robot" class="text-base" />
                </span>
                <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold text-content">{{ label }}</p>
                    <p class="mt-0.5 text-xs text-muted">
                        {{ handedOver ? t(`local.agentsTile.finishInBrowser`) : lead }}
                    </p>
                </div>
            </div>
            <Button :label="t(`ui.action.signIn`)" :loading="busy" size="small" class="w-full" @click="signIn">
                <template #icon><Icon name="sign-in" /></template>
            </Button>
            <Notice v-if="failure" tone="danger" class="text-2xs">{{ failure }}</Notice>
            <!-- What a reader who only came for their files needs to hear: nothing here depends on this. -->
            <p class="flex items-start gap-1.5 text-2xs text-subtle">
                <Icon name="lock" class="mt-px shrink-0" />
                <span>{{ t(`local.agentsTile.filesStayHere`) }}</span>
            </p>
        </div>
    </AnchoredOverlay>
</template>
