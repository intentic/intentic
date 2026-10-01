<script setup lang="ts">
import { AnchoredOverlay, Avatar, Button, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, watch } from "vue";
import { type LocalAccount, type LocalFacts, localHost } from "../app/environments/localHost";

// THE FOOT OF A LOCAL WINDOW'S RAIL, where the sandbox shell keeps the account, and the same control once there is one:
// who is signed in, the workspace, and the account's settings (signing out among them), each of which the workspace
// opens in this window's place. The account is what the workspace last told the app (localHost.ts `roster`), so before
// it has said, the control is the account without a name. The way to the sandboxes is the place chip above.
//
// An install that has never signed in is told what agents need and offered the sign-in instead, which runs in the
// default browser and comes back as the workspace. Nothing on this computer needs either.

const t = useT();
const host = localHost();

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

// Read on mount and whenever it opens: a sign-in finishing in the browser changes the answer while this window stays up.
const facts = ref<LocalFacts | undefined>(undefined);
const account = ref<LocalAccount | null>(null);
const read = async (): Promise<void> => {
    try {
        const [known, roster] = await Promise.all([host.facts(), host.roster()]);
        facts.value = known;
        account.value = roster.account;
    } catch (error) {
        console.error(`[local] what this install knows could not be read:`, error);
    }
};
onMounted(() => void read());
watch(open, (isOpen) => {
    if (isOpen) {
        failure.value = undefined;
        void read();
    }
});

const signedIn = computed(() => facts.value?.accountSeen === true);
const label = computed(() => (signedIn.value ? t(`shell.words.account`) : t(`local.agentsTile.putAgentsToWork`)));

// The avatar as the sandbox shell's account control draws it, and the same glyph once it will not load.
const avatarFailed = ref(false);
watch(account, () => {
    avatarFailed.value = false;
});
const avatarImage = computed<string | null>(() => (avatarFailed.value ? null : (account.value?.image ?? null)));

// Signing in happens in the default browser, so this window's part ends when the browser opens; it says so rather
// than sitting there as if nothing had been pressed.
const handedOver = ref(false);
const failure = ref<string | undefined>(undefined);
const busy = ref<string | undefined>(undefined);
const attempt = async (what: string, act: () => Promise<void>, closes: boolean): Promise<void> => {
    if (busy.value !== undefined) {
        return;
    }
    busy.value = what;
    failure.value = undefined;
    try {
        await act();
        if (closes) {
            open.value = false;
        }
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = undefined;
    }
};
const toWorkspace = (): void => void attempt(`workspace`, () => host.openWorkspace(), true);
const toSettings = (): void => void attempt(`settings`, () => host.openWorkspace(`/settings`), true);
const signIn = (): void =>
    void attempt(
        `sign-in`,
        async () => {
            await host.signIn();
            handedOver.value = true;
        },
        false,
    );

const rowClass = `flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5`;
</script>

<template>
    <!-- Signed in: the sandbox shell's account control, an avatar on the rail's foot. -->
    <div v-if="signedIn" class="local-account relative shrink-0">
        <button
            ref="trigger"
            type="button"
            class="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-line text-muted transition-colors hover:border-line-strong hover:bg-content/5 hover:text-content"
            :aria-label="label"
            :aria-expanded="open"
            v-tooltip.right="open ? undefined : label"
            @click="open = !open"
        >
            <img v-if="avatarImage" :src="avatarImage" alt="" referrerpolicy="no-referrer" class="h-full w-full object-cover" @error="avatarFailed = true" />
            <Icon v-else name="user" class="text-base" />
        </button>
    </div>
    <!-- No account yet: the one thing an account adds here, agents. -->
    <button
        v-else
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
        <!-- The sandbox shell's account menu: who, then where to go. Both open the workspace in this window's place. -->
        <div v-if="signedIn" class="flex w-60 flex-col p-1">
            <div v-if="account !== null" class="flex items-center gap-2 px-2 py-1.5">
                <Avatar :size="28" :src="avatarImage" />
                <div class="min-w-0 flex-1">
                    <div class="truncate text-xs font-medium text-content">{{ account.email }}</div>
                    <div v-if="account.name" class="truncate text-2xs text-muted">{{ account.name }}</div>
                </div>
            </div>
            <div v-if="account !== null" class="my-1 border-t border-line-subtle"></div>
            <button type="button" :class="rowClass" @click="toWorkspace">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center">
                    <Icon :name="busy === `workspace` ? `spinner` : `robot`" :spin="busy === `workspace`" class="text-base text-muted" />
                </span>
                <span class="min-w-0 flex-1 truncate">{{ t(`local.agentsTile.openWorkspace`) }}</span>
                <Icon name="arrow-up-right" class="shrink-0 text-2xs text-subtle" />
            </button>
            <button type="button" :class="rowClass" @click="toSettings">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center">
                    <Icon :name="busy === `settings` ? `spinner` : `cog`" :spin="busy === `settings`" class="text-base text-muted" />
                </span>
                <span class="min-w-0 flex-1 truncate">{{ t(`shared.settings`) }}</span>
                <Icon name="arrow-up-right" class="shrink-0 text-2xs text-subtle" />
            </button>
            <Notice v-if="failure" tone="danger" class="mx-2 mb-1 mt-1 text-2xs">{{ failure }}</Notice>
        </div>
        <div v-else class="flex w-72 flex-col gap-3 p-3">
            <div class="flex items-start gap-2.5">
                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-600/15 text-link">
                    <Icon name="robot" class="text-base" />
                </span>
                <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold text-content">{{ label }}</p>
                    <p class="mt-0.5 text-xs text-muted">
                        {{ handedOver ? t(`local.agentsTile.finishInBrowser`) : t(`local.agentsTile.agentsLead`) }}
                    </p>
                </div>
            </div>
            <Button :label="t(`ui.action.signIn`)" :loading="busy === `sign-in`" size="small" class="w-full" @click="signIn">
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

<style scoped>
/* The sandbox shell's account control's size (AccountPanel.vue), so the foot of either rail holds the same thing. */
.local-account {
    width: var(--icon-rail-account-size, 2.25rem);
    height: var(--icon-rail-account-size, 2.25rem);
}
</style>
