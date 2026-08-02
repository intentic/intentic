<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import { Avatar, type IconName } from "@intentic-app/ui";
import { computed, onMounted } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { type ActiveExtension, activationBadge, detectActivations, extensionPath, railBands } from "../core-views/registry";
import { badgeClass } from "../core-views/viewBadge";
import { usePanels } from "../composables/extensions/usePanels";
import { useSandboxAttention } from "../composables/sandbox/sandboxAttention";
import { identityHue } from "../composables/identityHue";
import { presenceActivity, presenceOthers } from "../composables/usePresence";
import { useSandbox } from "../composables/sandbox/useSandbox";

/* The mobile Menu tab: everything the desktop rail and its popovers hold, as one thumb-friendly page —
 * sandbox switching, the live presence roster, the area list (rail tiles), and the account actions. State
 * comes from the same singletons the desktop chrome reads; only the presentation is form-factor-specific. */

interface AreaRow {
    // The contributing extension's id — what railBands groups by, so this page's sections and the desktop rail's
    // hairline-separated runs are the same partition of the same list.
    readonly id: string;
    readonly to: string;
    readonly label: string;
    readonly icon?: IconName;
    // Same shape the rail badges with, so a core area and an extension say "there is something here" the one
    // way. There is no hover on a phone, so the row spells the badge's tooltip out where the rail would only
    // show its count.
    readonly badge?: ViewBadge;
}

// Activation.icon is an open string in the public extension API; trusted to name one of the app's icons.
const extensionRow = (active: ActiveExtension): AreaRow => {
    const { extension, activation } = active;
    const badge = activationBadge(active);
    return {
        id: extension.id,
        to: extensionPath(extension, activation),
        label: activation.title,
        ...(activation.icon === undefined ? {} : { icon: activation.icon as IconName }),
        ...(badge === undefined ? {} : { badge }),
    };
};

const router = useRouter();
const sandbox = useSandbox();
const { user, plan, entitlements, upgradeOpen, signOut } = useAuth();
const { panels } = usePanels();
const { capabilities } = useCapabilities();
/* What the sandbox needs from its owner. The desktop splits this across two surfaces — a badge on the rail's
 * collapsed chip, the sentences in the popover it opens — and the phone splits it the same way: the Menu TAB
 * carries the badge, and this page, which is what the tab opens, carries the rows. So the Sandbox row below
 * takes no badge of its own: on desktop the chip and its popover are never on screen together, here they
 * would be, and a chip restating the section right above it is the badge saying nothing twice. */
const { items: sandboxAttention } = useSandboxAttention();

onMounted(() => {
    if (sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
});

/* The rail's extension tiles, same detection AND same bands as ShellDesktop — Workspace/Drafts/Chat live on the
 * tab bar, so the menu lists only the remaining areas. The desktop rail separates its bands with a hairline
 * because 44px leaves no room for a word; this page has the width, so it spells the band names out. Same
 * partition either way, which is the point of railBands living in the registry. */
const areaBands = computed(() =>
    railBands(
        detectActivations(panels.value, capabilities.value)
            .filter(({ extension }) => extension.surface === `rail`)
            .map(extensionRow),
        (area) => area.id,
    ),
);
// The box rather than the work — the same things the desktop rail keeps below its last divider, next to the
// terminal and the "+". Not banded: none of them is an area a rail tile ever stood for.
const sandboxRows: readonly AreaRow[] = [
    { id: `capabilities`, to: `/capabilities`, label: `Add a capability`, icon: `plus` },
    { id: `terminal`, to: `/terminal`, label: `Terminal`, icon: `code` },
    { id: `sandbox`, to: `/sandbox`, label: `Sandbox`, icon: `box` },
    { id: `settings`, to: `/settings`, label: `Settings`, icon: `cog` },
];

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
        <!-- What the badge on this page's own tab is about: one row per pending item, each tapping through to
             the hub tab that resolves it. First on the page, because the badge is what brought the reader. -->
        <section v-if="sandboxAttention.length > 0" class="flex flex-col gap-1">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Needs you</h2>
            <RouterLink
                v-for="item in sandboxAttention"
                :key="item.message"
                :to="item.to"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-sm text-content transition-colors active:bg-overlay"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center" :class="item.tone === 'warning' ? 'text-warning' : 'text-link'">
                    <Icon :name="item.icon" class="text-base" />
                </span>
                <span class="min-w-0 flex-1 text-xs">{{ item.message }}</span>
                <Icon name="chevron-right" class="shrink-0 text-xs text-subtle" />
            </RouterLink>
        </section>

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
                    <Avatar
                        :size="32"
                        :name="member.name ?? member.email"
                        :src="member.picture"
                        :hue="identityHue(member.email)"
                        :idle="member.idle"
                    />
                    <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm text-content">{{ member.name ?? member.email }}</span>
                        <span class="block truncate text-xs text-muted">{{ presenceActivity(member) }}{{ member.idle ? " · away" : "" }}</span>
                    </span>
                </div>
            </div>
        </section>

        <!-- The areas the desktop rail links to (minus the ones on the tab bar), in the rail's own bands — the
             headings the 44px column can only imply with a hairline. -->
        <section v-for="band in areaBands" :key="band.group.id" class="flex flex-col gap-1">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ band.group.label }}</h2>
            <RouterLink
                v-for="area in band.items"
                :key="area.to"
                :to="area.to"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-sm text-content transition-colors active:bg-overlay"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center">
                    <Icon v-if="area.icon" :name="area.icon" class="text-base text-muted" />
                    <span v-else class="text-xs font-semibold text-muted">{{ area.label.slice(0, 2).toUpperCase() }}</span>
                </span>
                <span class="min-w-0 flex-1 truncate">{{ area.label }}</span>
                <span v-if="area.badge" class="shrink-0 rounded-full px-1.5 py-px text-2xs font-semibold" :class="badgeClass(area.badge)">{{
                    area.badge.tooltip ?? area.badge.count
                }}</span>
                <Icon name="chevron-right" class="shrink-0 text-xs text-subtle" />
            </RouterLink>
        </section>

        <!-- The box rather than the work, matching what the desktop rail keeps below its last divider. -->
        <section class="flex flex-col gap-1">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Sandbox</h2>
            <RouterLink
                v-for="row in sandboxRows"
                :key="row.to"
                :to="row.to"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-sm text-content transition-colors active:bg-overlay"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center"><Icon :name="row.icon!" class="text-base text-muted" /></span>
                <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
                <Icon name="chevron-right" class="shrink-0 text-xs text-subtle" />
            </RouterLink>
        </section>

        <!-- Account: identity + billing tier and the actions the desktop avatar popover holds. -->
        <section class="flex flex-col gap-1 pb-4">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Account</h2>
            <div class="flex h-14 items-center gap-3 px-2">
                <Avatar :size="40" :src="user?.image" />
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
