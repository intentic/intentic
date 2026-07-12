<script setup lang="ts">
import type { IconName } from "@intentic-app/ui";
import { computed, onMounted } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { detectActivations } from "../extensions/registry";
import { usePanels } from "../composables/extensions/usePanels";
import { presenceActivity, presenceHue, presenceInitials, presenceOthers } from "../composables/usePresence";
import { useSandbox } from "../composables/useSandbox";

/* The mobile Menu tab: everything the desktop rail and its popovers hold, as one thumb-friendly page —
 * sandbox switching, the live presence roster, the area list (rail tiles), and the account actions. State
 * comes from the same singletons the desktop chrome reads; only the presentation is form-factor-specific. */

interface AreaRow {
    readonly to: string;
    readonly label: string;
    readonly icon?: IconName;
}

const router = useRouter();
const sandbox = useSandbox();
const { user, plan, entitlements, upgradeOpen, signOut } = useAuth();
const { panels } = usePanels();
const { capabilities } = useCapabilities();

onMounted(() => {
    if (sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
});

// The rail's extension tiles, same detection as ShellDesktop — Workspace/Drafts/Chat live on the tab bar, so
// the menu lists only the remaining areas.
const areas = computed<readonly AreaRow[]>(() => [
    { to: `/automations`, label: `Automations`, icon: `clock` },
    { to: `/secrets`, label: `Secrets`, icon: `key` },
    ...detectActivations(panels.value, capabilities.value)
        .filter(({ extension }) => extension.surface === `rail`)
        .map(({ extension, activation }): AreaRow => {
            const to = `/ext/${extension.id}/${encodeURIComponent(activation.key)}`;
            // Activation.icon is an open string in the public extension API; trusted to name one of the app's icons.
            return activation.icon === undefined ? { to, label: activation.title } : { to, label: activation.title, icon: activation.icon as IconName };
        }),
    { to: `/capabilities`, label: `Add a capability`, icon: `plus` },
    { to: `/terminal`, label: `Terminal`, icon: `code` },
    { to: `/sandbox`, label: `Sandbox`, icon: `box` },
    { to: `/settings`, label: `Settings`, icon: `cog` },
]);

const addSandbox = (): void => {
    const limit = entitlements.value?.sandboxLimit;
    if (limit !== undefined && sandbox.sandboxes.value.filter((option) => option.role === `owner`).length >= limit) {
        upgradeOpen.value = true;
        return;
    }
    void router.push(`/setup`);
};

const logout = async (): Promise<void> => {
    await signOut();
    globalThis.location.href = `/login`;
};
</script>

<template>
    <div class="mx-auto flex w-full max-w-lg flex-col gap-6 p-4">
        <!-- Sandboxes: tap to switch; the active one shows its live status dot. -->
        <section class="flex flex-col gap-1">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Sandboxes</h2>
            <button
                v-for="option in sandbox.sandboxes.value"
                :key="option.id"
                type="button"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-left text-sm transition-colors active:bg-overlay"
                :class="option.id === sandbox.activeSandboxId.value ? 'bg-primary-600/15' : ''"
                @click="sandbox.select(option.id)"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-card text-muted">
                    <img v-if="option.image" :src="option.image" alt="" class="h-full w-full object-cover" />
                    <Icon name="server" v-else />
                </span>
                <span class="min-w-0 flex-1 truncate" :class="option.id === sandbox.activeSandboxId.value ? 'text-link' : 'text-content'">{{
                    option.name
                }}</span>
                <span v-if="option.role === 'member'" class="shrink-0 rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-medium text-subtle"
                    >Shared</span
                >
                <span
                    v-if="option.id === sandbox.activeSandboxId.value"
                    class="h-2 w-2 shrink-0 rounded-full"
                    :class="sandbox.reachable.value ? 'bg-success' : 'bg-subtle'"
                ></span>
            </button>
            <button
                type="button"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-left text-sm text-content transition-colors active:bg-overlay"
                @click="addSandbox"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center"><Icon name="plus" class="text-base text-muted" /></span>
                Add sandbox
            </button>
        </section>

        <!-- The other members connected right now — same roster the desktop rail stacks. -->
        <section v-if="presenceOthers.length > 0" class="flex flex-col gap-2">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Here now</h2>
            <div class="flex flex-col gap-1">
                <div v-for="member in presenceOthers" :key="member.email" class="flex h-11 items-center gap-3 px-2">
                    <span
                        class="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full"
                        :class="{ 'opacity-50 grayscale': member.idle }"
                        :style="{ backgroundColor: `hsl(${presenceHue(member.email)} 55% 42%)` }"
                    >
                        <span class="text-2xs font-semibold text-white">{{ presenceInitials(member) }}</span>
                        <img
                            v-if="member.picture"
                            :src="member.picture"
                            alt=""
                            referrerpolicy="no-referrer"
                            class="absolute inset-0 h-full w-full object-cover"
                        />
                    </span>
                    <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm text-content">{{ member.name ?? member.email }}</span>
                        <span class="block truncate text-xs text-muted">{{ presenceActivity(member) }}{{ member.idle ? " · away" : "" }}</span>
                    </span>
                </div>
            </div>
        </section>

        <!-- The areas the desktop rail links to (minus the ones on the tab bar). -->
        <section class="flex flex-col gap-1">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Areas</h2>
            <RouterLink
                v-for="area in areas"
                :key="area.to"
                :to="area.to"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-sm text-content transition-colors active:bg-overlay"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center">
                    <Icon v-if="area.icon" :name="area.icon" class="text-base text-muted" />
                    <span v-else class="text-xs font-semibold text-muted">{{ area.label.slice(0, 2).toUpperCase() }}</span>
                </span>
                <span class="min-w-0 flex-1 truncate">{{ area.label }}</span>
                <Icon name="chevron-right" class="shrink-0 text-xs text-subtle" />
            </RouterLink>
        </section>

        <!-- Account: identity + billing tier and the actions the desktop avatar popover holds. -->
        <section class="flex flex-col gap-1 pb-4">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Account</h2>
            <div class="flex h-14 items-center gap-3 px-2">
                <span
                    class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-content/5 text-muted"
                >
                    <img v-if="user?.image" :src="user.image" alt="" referrerpolicy="no-referrer" class="h-full w-full object-cover" />
                    <Icon name="user" v-else />
                </span>
                <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-2">
                        <span class="truncate text-sm font-medium text-content">{{ user?.email }}</span>
                        <span
                            v-if="plan"
                            class="shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-semibold leading-none"
                            :class="plan === 'pro' ? 'bg-primary-600/15 text-link' : 'bg-content/10 text-subtle'"
                        >
                            {{ plan === "pro" ? "Pro" : "Free" }}
                        </span>
                    </span>
                    <span v-if="user?.name" class="block truncate text-xs text-muted">{{ user.name }}</span>
                </span>
            </div>
            <button
                v-if="plan === 'free'"
                type="button"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-left text-sm text-content transition-colors active:bg-overlay"
                @click="upgradeOpen = true"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center"><Icon name="arrow-circle-up" class="text-base text-muted" /></span>
                Upgrade
            </button>
            <button
                type="button"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-left text-sm text-content transition-colors active:bg-overlay"
                @click="logout"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center"><Icon name="sign-out" class="text-base text-muted" /></span>
                Sign out
            </button>
        </section>

    </div>
</template>
