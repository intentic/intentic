<script setup lang="ts">
import type { Disposable } from "@intentic/extension-api";
import { AnchoredOverlay, Avatar, browserOwnsClick, StatusBadge, vAction } from "@intentic/ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ACCOUNT } from "./commands/categories";
import { registerCommand } from "./commands/useCommands";
import { useAuth } from "../features/auth/useAuth";
import { useHostedPlan } from "../features/settings/hosted-plan/useHostedPlan";
import { environment } from "../app/environments/environment";
import { useT } from "@intentic/ui/i18n";

// The rail's bottom account control: an avatar opening a popover with account identity (email, name,
// plan) and actions (Settings, Sign out). The sandbox switcher lives above; theme lives on /settings.

const t = useT();

const { user, signOut } = useAuth();
const route = useRoute();

// A chip stating the account's plan, not a clickable row; absent where the platform sells no plan.
const { planBadge } = useHostedPlan();

// Settings has no rail tile; this control lights up like one, matching on the route and any sub-path.
const onSettings = computed(() => route.path === `/settings` || route.path.startsWith(`/settings/`));

const accountHint = `Account`;

// AnchoredOverlay, not PrimeVue's Popover: shares the one overlay that measures against its anchor's window.
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const avatarFailed = ref(false);

const avatarImage = computed<string | null>(() => (avatarFailed.value ? null : (user.value?.image ?? null)));

const avatarLoadFailed = (): void => {
    avatarFailed.value = true;
};

// Settings is a place, so its row is a RouterLink anchor, keeping the address bar, Ctrl/Cmd-click and
// "open in new tab"; sign out is a button, since it happens rather than goes somewhere.
const dismiss = (event: MouseEvent): void => {
    if (!browserOwnsClick(event)) {
        open.value = false;
    }
};

const logout = async (): Promise<void> => {
    await signOut();
    // Full navigation, not a router push: afterSignOut may point outside this SPA.
    globalThis.location.href = environment.afterSignOut;
};

// The other half of this popover is a place (Settings, a destination like any other); this half is the one thing the
// account menu does, registered here so the palette runs the same flow rather than a second copy of it.
let command: Disposable | undefined;

onMounted(() => {
    command = registerCommand({
        owner: `builtin`,
        command: `account.signOut`,
        title: t(`shell.accountPanel.signOut2`),
        category: ACCOUNT,
        icon: `sign-out`,
        handler: logout,
    });
});

onUnmounted(() => {
    command?.dispose();
    command = undefined;
});
</script>

<template>
    <!-- The dot sits outside the avatar's clip circle; the wrapper positions it, the button keeps overflow-hidden. -->
    <!-- The active plate is a sibling so the avatar image remains undecorated. -->
    <div class="account-control relative mt-auto shrink-0">
        <span v-if="onSettings" class="pointer-events-none absolute -inset-1 rounded-lg bg-primary-600/15" aria-hidden="true"></span>
        <button
            ref="trigger"
            type="button"
            class="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border transition-colors hover:border-line-strong hover:bg-content/5 hover:text-content"
            :class="onSettings ? `border-line text-link` : `border-line text-muted`"
            :aria-label="accountHint"
            :aria-current="onSettings ? 'page' : undefined"
            v-tooltip.right="accountHint"
            :aria-expanded="open"
            @click="open = !open"
        >
            <img
                v-if="avatarImage"
                :src="avatarImage"
                alt=""
                referrerpolicy="no-referrer"
                class="h-full w-full object-cover"
                @error="avatarLoadFailed"
            />
            <Icon name="user" v-else class="text-base" />
        </button>
    </div>

    <!-- Same inset as the sandbox switcher above; the popover's default padding is a content card's, not a menu's. -->
    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="right" cross="end">
        <div class="flex w-60 flex-col p-1">
            <!-- Chip sits beside the name (or email when there is no name), not on its own row below the identity block. -->
            <div class="flex items-center gap-2 px-2 py-1.5">
                <Avatar :size="28" :src="avatarImage" />
                <div class="min-w-0 flex-1">
                    <div :class="user?.name ? undefined : `flex min-w-0 items-center gap-1.5`">
                        <span class="truncate text-xs font-medium text-content" :class="user?.name ? undefined : `min-w-0`">{{ user?.email }}</span>
                        <StatusBadge
                            v-if="planBadge && !user?.name"
                            :variant="planBadge.variant"
                            :label="planBadge.label"
                            size="xs"
                            class="shrink-0"
                            v-tooltip.right="planBadge.detail"
                        />
                    </div>
                    <div v-if="user?.name" class="flex min-w-0 items-center gap-1.5">
                        <span class="min-w-0 truncate text-2xs text-muted">{{ user.name }}</span>
                        <StatusBadge
                            v-if="planBadge"
                            :variant="planBadge.variant"
                            :label="planBadge.label"
                            size="xs"
                            class="shrink-0"
                            v-tooltip.right="planBadge.detail"
                        />
                    </div>
                </div>
            </div>

            <div class="my-1 border-t border-line"></div>

            <RouterLink
                to="/settings"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                @click="dismiss"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="cog" class="text-base text-muted" /></span>
                {{ t(`shell.accountPanel.settings`) }}
            </RouterLink>
            <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
                v-action="logout"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="sign-out" class="text-base text-muted" /></span>
                {{ t(`shell.accountPanel.signOut`) }}
            </button>
        </div>
    </AnchoredOverlay>
</template>

<style scoped>
.account-control {
    width: var(--icon-rail-account-size, 2.25rem);
    height: var(--icon-rail-account-size, 2.25rem);
}
</style>
