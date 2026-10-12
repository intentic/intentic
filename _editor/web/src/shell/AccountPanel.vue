<script setup lang="ts">
import { useGettingStarted } from "../features/gettingStarted/useGettingStarted";
import type { Disposable } from "@intentic/extension-api";
import { AnchoredOverlay, Avatar, browserOwnsClick, Notice, StatusBadge, useHoverMenu, vAction } from "@intentic/ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { ACCOUNT } from "../workbench/commands/categories";
import { registerCommand } from "../workbench/commands/useCommands";
import { useAccount } from "../client/auth/useAccount";
import { useHostedPlan } from "../features/settings/hosted-plan/useHostedPlan";
import { environment } from "../app/environments/environment";
import { useT } from "@intentic/ui/i18n";

// The rail's bottom account control: an avatar opening a popover with account identity (email, name,
// plan) and actions (Settings, Sign out). It opens as the sandbox logo at the rail's top does (useHoverMenu): resting
// on it raises the panel, a passing pointer raises nothing, and a press pins it. The rail's two end controls are the
// same kind of thing, an identity with a short menu under it, so they answer the pointer the same way. The sandbox switcher lives above; theme lives on /settings. The same control at
// the foot of a desktop window on a folder of this computer (local/LocalShell.vue), drawn and pressed the same: there the
// account is the one the app reaches for the window (useAccount.ts), and Settings opens in that window.

const t = useT();

const account = useAccount();
const { user } = account;
const route = useRoute();
const router = useRouter();

// A chip stating the account's plan, not a clickable row; absent where the platform sells no plan.
const { planBadge } = useHostedPlan();

// Settings has no rail tile; this control lights up like one, matching on the route and any sub-path.
const onSettings = computed(() => route.path === `/settings` || route.path.startsWith(`/settings/`));

const accountHint = computed(() => t(`shell.words.account`));

// AnchoredOverlay, not PrimeVue's Popover: shares the one overlay that measures against its anchor's window.
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const menu = useHoverMenu(panel);
const open = menu.open;
const pressed = menu.pressed;
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

// Why the last Sign out did not sign anybody out, in the words it came back with (the platform's, or the desktop app's
// for a local window it could not carry the call for). Until 2026-10-12 a refused or unreachable sign-out left the menu
// as it was and said nothing, and the reader stayed signed in without knowing it.
const signOutFailure = ref<string | undefined>(undefined);
watch(open, (isOpen) => {
    if (!isOpen) {
        signOutFailure.value = undefined;
    }
});

const logout = async (): Promise<void> => {
    signOutFailure.value = undefined;
    try {
        await account.signOut();
    } catch (error) {
        signOutFailure.value = error instanceof Error ? error.message : String(error);
        // Said in the menu, pinned open: the palette's Sign out has no menu up to say it in.
        open.value = true;
        return;
    }
    if (account.local) {
        // A window on a folder stays on its folder: what signing out ends there is the account, not the window's work.
        open.value = false;
        if (onSettings.value) {
            await router.push(`/workspace`);
        }
        return;
    }
    // Full navigation, not a router push: afterSignOut may point outside this SPA.
    globalThis.location.href = environment.afterSignOut;
};

const tour = useGettingStarted();
const reopenTour = (): void => {
    open.value = false;
    void tour.show();
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
            aria-haspopup="dialog"
            :aria-expanded="open"
            v-on="menu.trigger"
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

    <!-- No tooltip on the avatar: resting there opens this panel, on the side a tooltip would take, and its first row
         says whose account it is. Same inset as the sandbox switcher above; focus goes back to the avatar only when a
         press opened it, since a panel the pointer raised never took the keyboard's place. -->
    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="right" cross="end" :restore-focus="pressed" menu>
        <div ref="panel" class="flex w-60 flex-col p-1" v-on="menu.panel">
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

            <div class="my-1 border-t border-line-subtle"></div>

            <!-- Only while it is put away and still a first run: the way back to a checklist the rail no longer shows. -->
            <button
                v-if="tour.reopenable.value"
                type="button"
                data-menu-row
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
                @click="reopenTour"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="circle" class="text-base text-muted" /></span>
                {{ t(`gettingStarted.panel.show`) }}
            </button>
            <RouterLink
                to="/settings"
                data-menu-row
                :data-current="onSettings || undefined"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                @click="dismiss"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="cog" class="text-base text-muted" /></span>
                {{ t(`shared.settings`) }}
            </RouterLink>
            <button
                type="button"
                data-menu-row
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
                v-action="logout"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="sign-out" class="text-base text-muted" /></span>
                {{ t(`shell.words.signOut`) }}
            </button>
            <Notice v-if="signOutFailure" tone="danger" class="m-1 text-2xs" data-test="sign-out-failure">{{ signOutFailure }}</Notice>
        </div>
    </AnchoredOverlay>
</template>

<style scoped>
.account-control {
    width: var(--icon-rail-account-size, 2.25rem);
    height: var(--icon-rail-account-size, 2.25rem);
}
</style>
