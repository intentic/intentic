<script setup lang="ts">
import { Avatar } from "@intentic/ui";
import Popover from "primevue/popover";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { creditSummary } from "../composables/membership/creditMeter";
import { useMembership } from "../composables/membership/useMembership";
import { useAuth } from "../composables/useAuth";
import { environment } from "../environments/environment";
import AccountCredits from "./AccountCredits.vue";

/* The rail's bottom account control: an avatar that opens a popover scoped to the account (email + name), the
 * day's credit balance, and the account actions (Settings, Sign out). The sandbox and its status live in the
 * rail's top switcher; personal preferences (theme) live on the /settings page.
 *
 * CREDITS BELONG TO THE PERSON, WHICH IS WHY THEY ARE HERE — see AccountCredits for the whole argument. What
 * this file adds on top of that row is the only part of it that reaches the app frame: the tooltip, and a dot
 * when the allowance is gone. */

const { user, signOut } = useAuth();
const router = useRouter();
const route = useRoute();

/* THE SETTINGS PAGES HAVE NO TILE, SO THE CONTROL THAT OPENS THEM IS THE TILE. /settings and its tabs are
 * reached from this avatar's menu and from nowhere else in the rail, which left the whole area as the one place
 * in the app where the frame said nothing about where you were standing. Lit on the same terms as a navigation
 * tile (route AND any sub-path, so a tab keeps it), in the same accent — the avatar is round and bordered
 * rather than a plate, so the accent lands on its ring and its glyph. */
const onSettings = computed(() => route.path === `/settings` || route.path.startsWith(`/settings/`));

/* THE BALANCE, WITHOUT OPENING ANYTHING. Two escalating steps, and deliberately no third:
 *
 *  - The tooltip already existed and said "Account", which is what the avatar plainly is. Given a meter it says
 *    the balance instead — so a member can learn what is left by resting a pointer, and nothing is added to the
 *    rail to make that true.
 *  - A dot, and ONLY when the allowance is actually spent. That is the one credit state where something a person
 *    tries will be refused, so it is the one worth a mark on the frame. Not for "low": running out later today
 *    is not news that has to interrupt anybody, and a permanent gauge on the rail would read as the metering
 *    this product promises it does not do. */
const { meter } = useMembership();

const accountHint = computed(() => (meter.value === undefined ? `Account` : creditSummary(meter.value)));

const panel = ref<InstanceType<typeof Popover> | null>(null);
const avatarFailed = ref(false);

const avatarImage = computed<string | null>(() => (avatarFailed.value ? null : (user.value?.image ?? null)));

const avatarLoadFailed = (): void => {
    avatarFailed.value = true;
};

const openSettings = (): void => {
    panel.value?.hide();
    void router.push(`/settings`);
};

const logout = async (): Promise<void> => {
    await signOut();
    // A full navigation, not a router push: the environment's landing may live outside this SPA entirely (the
    // demo's is the site's homepage).
    globalThis.location.href = environment.afterSignOut;
};
</script>

<template>
    <!-- The dot sits OUTSIDE the avatar's clipping circle, so the wrapper carries the position and the button
         keeps its overflow-hidden (an avatar image has to be clipped round; a marker must not be). -->
    <!-- THE "YOU ARE HERE" MARK IS A LIT PLATE BEHIND THE AVATAR — the same plate every navigation tile above
         wears while you stand on its view, in the same accent, at the same corner radius. Anything drawn ON the
         avatar fails twice over: a photo fills the circle edge to edge, so a border under it is invisible, and
         a ring around it puts a coloured collar on somebody's face — a decoration of the person, not a
         statement about the app's frame. Behind it, the rail is doing the talking, which is whose job it is.

         The plate is a sibling, absolutely positioned, so the avatar keeps its own round clip and its size: the
         control does not grow, shift the column, or move by a pixel between the two states. -->
    <div class="account-control relative mt-auto shrink-0">
        <span v-if="onSettings" class="pointer-events-none absolute -inset-1 rounded-lg bg-primary-600/15" aria-hidden="true"></span>
        <button
            type="button"
            class="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border transition-colors hover:border-line-strong hover:bg-content/5 hover:text-content"
            :class="onSettings ? `border-line text-link` : `border-line text-muted`"
            :aria-label="accountHint"
            :aria-current="onSettings ? 'page' : undefined"
            v-tooltip.right="accountHint"
            @click="panel?.toggle($event)"
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
        <!-- Ringed in the rail's own background so it reads as a marker ON the avatar rather than a stray pixel
             beside it. aria-hidden: the button's label already says the balance in words. -->
        <span
            v-if="meter?.spent"
            class="pointer-events-none absolute -right-px -top-px size-2 rounded-full bg-warning ring-2 ring-canvas"
            aria-hidden="true"
        />
    </div>

    <!-- Same inset as the sandbox switcher above it in the rail: the theme's popover padding is a content
         card's, and these are menu rows that carry their own. -->
    <Popover ref="panel" append-to="body" :pt="{ content: { class: `!p-0` } }">
        <div class="flex w-60 flex-col p-1">
            <!-- Central account: email + name. -->
            <div class="flex items-center gap-2 px-2 py-1.5">
                <Avatar :size="28" :src="avatarImage" />
                <div class="min-w-0 flex-1">
                    <span class="truncate text-xs font-medium text-content">{{ user?.email }}</span>
                    <div v-if="user?.name" class="truncate text-2xs text-muted">{{ user.name }}</div>
                </div>
            </div>

            <div class="my-1 border-t border-line"></div>

            <!-- The day's allowance, between who you are and what you can do — it is a fact about the account,
                 and it is the reason somebody opens this menu without wanting either Settings or Sign out.
                 Dismisses the menu on its way to the membership page like every other row here. -->
            <AccountCredits @click="panel?.hide()" />

            <div v-if="meter" class="my-1 border-t border-line"></div>

            <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                @click="openSettings"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="cog" class="text-xs text-muted" /></span>
                Settings
            </button>
            <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                @click="logout"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="sign-out" class="text-xs text-muted" /></span>
                Sign out
            </button>
        </div>
    </Popover>
</template>

<style scoped>
.account-control {
    width: var(--icon-rail-account-size, 2.25rem);
    height: var(--icon-rail-account-size, 2.25rem);
}
</style>
