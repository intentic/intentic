<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { useGettingStarted } from "../features/gettingStarted/useGettingStarted";
import CommunityInvite from "../features/community/CommunityInvite.vue";
import { useCommunityInvite } from "../features/community/useCommunityInvite";
import type { Disposable } from "@intentic/extension-api";
import { AnchoredOverlay, Avatar, browserOwnsClick, Notice, StatusBadge, useDevice, useHoverMenu, vAction } from "@intentic/ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { registerBuiltin } from "../workbench/commands/builtinCommands";
import { useAccount } from "../client/auth/useAccount";
import type { SignedOutAs } from "../client/auth/deviceAccounts";
import type { DeviceSession } from "../client/auth/useAuth";
import { MAX_DEVICE_ACCOUNTS } from "@intentic/api-contract";
import { useHostedPlan } from "../models/hosted-plan/useHostedPlan";
import { leaveAfterSignOut } from "../app/environments/afterSignOut";
import { desktopApp, openThisComputer } from "../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";
import { DELETED_PATH } from "../lib/routes/home";
import { useDeletedCount } from "../models/home/sandboxTrash";

// The rail's bottom account control: an avatar opening a popover with account identity (email, name,
// plan) and actions (Settings, Recently deleted while a sandbox can come back, This computer in the desktop app, Sign out). It opens as the sandbox logo at the rail's top does (useHoverMenu): resting
// on it raises the panel, a passing pointer raises nothing, and a press pins it. The rail's two end controls are the
// same kind of thing, an identity with a short menu under it, so they answer the pointer the same way. The sandbox switcher lives above; theme lives on /settings. The same control at
// the foot of a desktop window on a folder of this computer (local/LocalShell.vue), drawn and pressed the same: there the
// account is the one the app reaches for the window (useAccount.ts), and Settings opens in that window.
// And at the foot of the phone's rail (MobileRail.vue), where a press is the only way in and its rows grow to a finger's
// height (`pointer-coarse:`).

const t = useT();

const account = useAccount();
const { user } = account;
const route = useRoute();
const router = useRouter();

// A chip stating the account's plan, not a clickable row; absent where the platform sells no plan.
const { planBadge } = useHostedPlan();

// Settings has no rail tile; this control lights up like one, matching on the route and any sub-path.
const onSettings = computed(() => route.path === `/settings` || route.path.startsWith(`/settings/`));
// The account's deleted sandboxes are its page too, so the avatar lights there as well.
const onDeleted = computed(() => route.name === `deleted-sandboxes`);
const onAccountPage = computed(() => onSettings.value || onDeleted.value);

// The community invitation (features/community): a quiet dot here while an ask waits unseen in this menu, never more.
// Said to analytics as the phone's when this is the phone rail's avatar (MobileRail.vue), so the two stay comparable.
const invite = useCommunityInvite();
const { mobile } = useDevice();
const accountHint = computed(() => (invite.dot.value ? t(`community.dot`) : t(`shell.words.account`)));

// AnchoredOverlay, not PrimeVue's Popover: shares the one overlay that measures against its anchor's window.
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const menu = useHoverMenu(panel);
const open = menu.open;
const pressed = menu.pressed;
const avatarFailed = ref(false);

// The account's deleted sandboxes that can still come back: a row of this menu while there is one, never a row of a
// list of sandboxes (the switcher, Home's rail), where it sat until 2026-10-27 as the loudest row in the place a reader
// picks a box to work in. Read from the first rest on the avatar, so the row is there by the time the panel is.
const deletedCount = useDeletedCount(() => !account.local && (open.value || menu.hovering.value));

// The other accounts signed in on this browser, asked as the reader comes to the menu, as the deleted count is: a press on
// one switches to it, the platform making it the active account and the page leaving for it (client/auth/deviceAccounts.ts).
// A local window offers those the workspace signed in, and stays on its folder as the one it moves to (useAccount.ts);
// neither it nor the Android app adds one here, the workspace's and the Android app's own screens signing in.
const others = account.others;
// Asked once as the control first draws too: a press on a phone has no rest before it, and rows arriving a frame after
// the menu opened pushed everything under them down.
onMounted(() => {
    if (!account.local) {
        void account.refreshOthers();
    }
});
const comingToMenu = computed(() => open.value || menu.hovering.value);
watch(comingToMenu, (coming) => {
    if (coming) {
        void account.refreshOthers();
    }
});
const canAddAccount = computed(() => account.add !== undefined && account.canAdd.value);
const switchingTo = ref<string | undefined>(undefined);

// Computer tools are an occasional destination, reached here rather than among Home's sandbox tiles. A local window
// is already on this computer, so it needs no link back to itself.
const hasThisComputer = desktopApp() !== undefined && !account.local;
const showThisComputer = (): void => {
    open.value = false;
    openThisComputer();
};

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
// as it was and said nothing, and the reader stayed signed in without knowing it. A switch that could not happen (that
// sign-in ended) says so here too.
const signOutFailure = ref<string | undefined>(undefined);
watch(open, (isOpen) => {
    if (!isOpen) {
        signOutFailure.value = undefined;
    }
});

// Said in the menu, pinned open: the palette's commands have no menu up to say it in.
const fail = (message: string): void => {
    signOutFailure.value = message;
    open.value = true;
};

// A window on a folder stays on its folder whichever account it is now, or nobody's: what changes there is the account,
// not the window's work. Settings, drawn for the account the menu was opened as, is left; the switch's row is freed,
// since no navigation follows to take it away.
const stayOnFolder = async (): Promise<void> => {
    switchingTo.value = undefined;
    open.value = false;
    if (onSettings.value) {
        await router.push(`/workspace`);
    }
};

const switchTo = async (other: DeviceSession): Promise<void> => {
    signOutFailure.value = undefined;
    switchingTo.value = other.token;
    try {
        await account.switchTo(other);
    } catch (error) {
        switchingTo.value = undefined;
        fail(errorMessage(error));
        return;
    }
    if (account.local) {
        await stayOnFolder();
    }
};

const addAccount = async (): Promise<void> => {
    const add = account.add;
    if (add === undefined || !account.canAdd.value) {
        return;
    }
    open.value = false;
    if (`run` in add) {
        add.run();
        return;
    }
    await router.push(add.path);
};

const logoutAll = async (): Promise<void> => {
    signOutFailure.value = undefined;
    try {
        await account.signOutAll();
    } catch (error) {
        fail(errorMessage(error));
        return;
    }
    if (!account.local) {
        leaveAfterSignOut();
    }
};

const logout = async (): Promise<void> => {
    signOutFailure.value = undefined;
    let ended: SignedOutAs;
    try {
        ended = await account.signOut();
    } catch (error) {
        fail(errorMessage(error));
        return;
    }
    if (account.local) {
        await stayOnFolder();
        return;
    }
    // Carried on as another account signed in here: the page is already on its way to it.
    if (ended === `switched`) {
        return;
    }
    leaveAfterSignOut();
};

const tour = useGettingStarted();
const reopenTour = (): void => {
    open.value = false;
    void tour.show();
};

// The other half of this popover is a place (Settings, a destination like any other); this half is the one thing the
// account menu does, registered here so the palette runs the same flow rather than a second copy of it.
// The community's door sits in this menu too, so the palette reaches it from wherever the reader is.
let commands: Disposable[] = [];

onMounted(() => {
    commands = [
        registerBuiltin(`account.signOut`, logout),
        registerBuiltin(`account.signOutAll`, logoutAll),
        registerBuiltin(`account.add`, addAccount),
        registerBuiltin(`account.joinCommunity`, () => invite.open(`palette`)),
    ];
});

onUnmounted(() => {
    for (const command of commands) {
        command.dispose();
    }
    commands = [];
});

// The plain row is a link like the note's Join: the reader found their own way in, which answers the ask too.
const communityPressed = (): void => {
    open.value = false;
    invite.answer(mobile.value ? `phone-menu` : `menu`, `joined`);
};
</script>

<template>
    <!-- The dot sits outside the avatar's clip circle; the wrapper positions it, the button keeps overflow-hidden. -->
    <!-- The active plate is a sibling so the avatar image remains undecorated. -->
    <div class="account-control relative mt-auto shrink-0">
        <span v-if="onAccountPage" class="pointer-events-none absolute -inset-1 rounded-lg bg-primary-600/15" aria-hidden="true"></span>
        <button
            ref="trigger"
            type="button"
            class="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border transition-colors hover:border-line-strong hover:bg-content/5 hover:text-content"
            :class="onAccountPage ? `border-line text-link` : `border-line text-muted`"
            :aria-label="accountHint"
            :aria-current="onAccountPage ? 'page' : undefined"
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
        <span
            v-if="invite.dot.value"
            class="pointer-events-none absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-accent ring-2 ring-canvas"
            aria-hidden="true"
            data-test="community-dot"
        ></span>
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

            <!-- The browser's other accounts, each a press away, and the way to add one: the same rows as the rest of the
                 menu, the face and address telling company from personal at a glance. -->
            <div v-if="others.length > 0" role="group" :aria-label="t(`auth.accounts.others`)" data-test="other-accounts">
                <button
                    v-for="other in others"
                    :key="other.token"
                    type="button"
                    data-menu-row
                    data-test="other-account"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5 pointer-coarse:py-2.5 pointer-coarse:text-sm"
                    :aria-label="t(`auth.accounts.switchTo`, { email: other.user.email })"
                    :title="other.user.email"
                    :aria-busy="switchingTo === other.token || undefined"
                    :disabled="switchingTo !== undefined"
                    @click="switchTo(other)"
                >
                    <Avatar :size="20" :src="other.user.image" class="shrink-0" />
                    <span class="min-w-0 flex-1 truncate">{{ other.user.email }}</span>
                    <Icon v-if="switchingTo === other.token" name="spinner" spin class="shrink-0 text-2xs text-subtle" />
                </button>
            </div>
            <button
                v-if="account.add !== undefined"
                type="button"
                data-menu-row
                data-test="add-account"
                class="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5 disabled:cursor-default disabled:text-subtle disabled:hover:bg-transparent pointer-coarse:py-2.5 pointer-coarse:text-sm"
                :disabled="!canAddAccount || switchingTo !== undefined"
                :title="canAddAccount ? undefined : t(`auth.accounts.limit`, { count: MAX_DEVICE_ACCOUNTS })"
                @click="addAccount"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="plus" class="text-base text-muted group-disabled:text-subtle" /></span>
                {{ t(`auth.accounts.add`) }}
            </button>

            <div class="my-1 border-t border-line-subtle"></div>

            <!-- The community ask, on the visit it is first seen on and only after the reader has been round the loop. -->
            <CommunityInvite v-if="invite.note.value" :place="mobile ? `phone-note` : `menu-note`" class="m-1 mb-2" />

            <!-- Only while it is put away and still a first run: the way back to a checklist the rail no longer shows. -->
            <button
                v-if="tour.reopenable.value"
                type="button"
                data-menu-row
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5 pointer-coarse:py-2.5 pointer-coarse:text-sm"
                @click="reopenTour"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="circle" class="text-base text-muted" /></span>
                {{ t(`gettingStarted.panel.show`) }}
            </button>
            <RouterLink
                to="/settings"
                data-menu-row
                :data-current="onSettings || undefined"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5 pointer-coarse:py-2.5 pointer-coarse:text-sm"
                @click="dismiss"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="cog" class="text-base text-muted" /></span>
                {{ t(`shared.settings`) }}
            </RouterLink>
            <RouterLink
                v-if="deletedCount > 0"
                :to="DELETED_PATH"
                data-menu-row
                :data-current="onDeleted || undefined"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5 pointer-coarse:py-2.5 pointer-coarse:text-sm"
                :aria-label="`${t(`sandbox.words.recentlyDeleted`)}, ${t(`sandbox.recentlyDeleted.toRestore`, { count: deletedCount }, deletedCount)}`"
                @click="dismiss"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="trash" class="text-base text-muted" /></span>
                <span class="min-w-0 flex-1 truncate">{{ t(`sandbox.words.recentlyDeleted`) }}</span>
                <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ deletedCount }}</span>
            </RouterLink>
            <button
                v-if="hasThisComputer"
                type="button"
                data-menu-row
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5 pointer-coarse:py-2.5 pointer-coarse:text-sm"
                @click="showThisComputer"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="desktop" class="text-base text-muted" /></span>
                {{ t(`sandbox.sandboxSwitcher.thisComputer`) }}
            </button>
            <a
                :href="invite.url"
                target="_blank"
                rel="noopener"
                data-menu-row
                data-test="community-row"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5 pointer-coarse:py-2.5 pointer-coarse:text-sm"
                @click="communityPressed"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="discord" class="text-base text-muted" /></span>
                <span class="min-w-0 flex-1 truncate">{{ t(`community.row`) }}</span>
                <Icon name="external-link" class="shrink-0 text-2xs text-subtle" />
            </a>
            <button
                type="button"
                data-menu-row
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5 pointer-coarse:py-2.5 pointer-coarse:text-sm"
                data-test="sign-out"
                v-action="logout"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="sign-out" class="text-base text-muted" /></span>
                {{ t(`shell.words.signOut`) }}
            </button>
            <!-- Only with another account here: Sign out above ends this one and carries on as the next. -->
            <button
                v-if="others.length > 0"
                type="button"
                data-menu-row
                data-test="sign-out-all"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5 pointer-coarse:py-2.5 pointer-coarse:text-sm"
                v-action="logoutAll"
            >
                <span class="h-5 w-5 shrink-0" aria-hidden="true"></span>
                {{ t(`auth.accounts.signOutAll`) }}
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
