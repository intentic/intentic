<script setup lang="ts">
import { Avatar } from "@intentic-app/ui";
import Popover from "primevue/popover";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";

/* The rail's bottom account control: an avatar that opens a popover scoped to the account (email + name),
 * the billing tier, and the account actions (Upgrade, Settings, Sign out). The sandbox and its status live
 * in the rail's top switcher; personal preferences (theme) live on the /settings page. The Upgrade dialog
 * itself is mounted once in App.vue — opened from here via useAuth's shared `upgradeOpen`. */

const { user, plan, upgradeOpen, refreshPlan, signOut } = useAuth();
const router = useRouter();

const panel = ref<InstanceType<typeof Popover> | null>(null);
const avatarFailed = ref(false);

const avatarImage = computed<string | null>(() => (avatarFailed.value ? null : (user.value?.image ?? null)));

const avatarLoadFailed = (): void => {
    avatarFailed.value = true;
};

onMounted(() => void refreshPlan());

const openUpgrade = (): void => {
    upgradeOpen.value = true;
    panel.value?.hide();
};

const openSettings = (): void => {
    panel.value?.hide();
    void router.push(`/settings`);
};

const logout = async (): Promise<void> => {
    await signOut();
    globalThis.location.href = `/login`;
};
</script>

<template>
    <button
        type="button"
        class="account-control mt-auto flex items-center justify-center overflow-hidden rounded-full border border-line text-muted transition-colors hover:border-line-strong hover:bg-content/5 hover:text-content"
        aria-label="Account"
        v-tooltip.right="'Account'"
        @click="panel?.toggle($event)"
    >
        <img v-if="avatarImage" :src="avatarImage" alt="" referrerpolicy="no-referrer" class="h-full w-full object-cover" @error="avatarLoadFailed" />
        <Icon name="user" v-else class="text-base" />
    </button>

    <Popover ref="panel" append-to="body" @show="refreshPlan">
        <div class="flex w-72 flex-col p-1">
            <!-- Central account: email + name, with the billing tier badge. -->
            <div class="flex items-center gap-3 px-2 py-2">
                <Avatar :size="40" :src="avatarImage" />
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                        <span class="truncate text-sm font-medium text-content">{{ user?.email }}</span>
                        <span
                            v-if="plan"
                            class="shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-semibold leading-none"
                            :class="plan === 'pro' ? 'bg-primary-600/15 text-link' : 'bg-content/10 text-subtle'"
                        >
                            {{ plan === "pro" ? "Pro" : "Free" }}
                        </span>
                    </div>
                    <div v-if="user?.name" class="truncate text-xs text-muted">{{ user.name }}</div>
                </div>
            </div>

            <div class="my-1 border-t border-line"></div>

            <button
                v-if="plan === 'free'"
                type="button"
                class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-content transition-colors hover:bg-content/5"
                @click="openUpgrade"
            >
                <Icon name="arrow-circle-up" class="text-base text-muted" />
                Upgrade
            </button>
            <button
                type="button"
                class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-content transition-colors hover:bg-content/5"
                @click="openSettings"
            >
                <Icon name="cog" class="text-base text-muted" />
                Settings
            </button>
            <button
                type="button"
                class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-content transition-colors hover:bg-content/5"
                @click="logout"
            >
                <Icon name="sign-out" class="text-base text-muted" />
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
