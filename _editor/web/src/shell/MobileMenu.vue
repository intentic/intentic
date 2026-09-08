<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import { Avatar, type IconName, vAction } from "@intentic/ui";
import { computed, onMounted } from "vue";
import { RouterLink } from "vue-router";
import { useAuth } from "../features/auth/useAuth";
import { useCapabilities } from "../features/capabilities/connect/useCapabilities";
import { type ActiveExtension, activationBadge, detectActivations, extensionPath, railBands, TAB_BAR_IDS } from "../core-views/registry";
import { badgeClass, badgeToneClass } from "../core-views/viewBadge";
import { usePanels } from "../features/extensions/usePanels";
import { useRole } from "../features/sandbox/secrets/useRole";
import { useSandboxAttention } from "../features/sandbox/overview/sandboxAttention";
import { identityHue } from "../lib/identityHue";
import { presenceActivity, presenceOthers } from "./presence/usePresence";
import { useSandbox } from "../features/sandbox/client/useSandbox";
import { connectedSandboxes, unfinishedSandboxes } from "../features/sandbox/live/roster";
import { sandboxAvailabilityVisual } from "../features/sandbox/overview/availability";
import { useSandboxAvailability } from "../features/sandbox/overview/useSandboxAvailability";
import { useWorkspaceTree } from "../features/workspace/explorer/useWorkspaceTree";
import { environment } from "../app/environments/environment";
import RailIcon from "./rail/RailIcon.vue";

// The mobile Menu tab: everything the desktop rail and its popovers hold, as one page — sandbox
// switching, the presence roster, the area list, account actions. Same state singletons, different
// presentation.

interface AreaRow {
    // Groups by railBands, so this page's sections match the desktop rail's runs.
    readonly id: string;
    readonly to: string;
    readonly label: string;
    readonly icon?: IconName;
    // Same shape the rail badges with; spelled out here since there's no hover to show a tooltip on tap.
    readonly badge?: ViewBadge;
}

// Activation.icon is an open string in the extension API, trusted to name an app icon.
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

const sandbox = useSandbox();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityVisual = computed(() => sandboxAvailabilityVisual(availability.value));
const { user, signOut } = useAuth();
const { panels } = usePanels();
const { capabilities } = useCapabilities();
// The Sandbox row below stays badge-free; the tab's own badge already flags this, so a chip would repeat it.
const { needs: sandboxAttention, notes: sandboxNotes } = useSandboxAttention();

onMounted(() => {
    if (sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
});

// Same detection and bands as ShellDesktop, but unfiltered by railSeated — no seat scarcity here.
const areaBands = computed(() =>
    railBands(
        detectActivations(panels.value, capabilities.value)
            .filter(({ extension }) => extension.surface === `rail` && !TAB_BAR_IDS.includes(extension.id))
            .map(extensionRow),
        (area) => area.id,
    ),
);
// Matches the desktop rail's tail (terminal, +); terminal needs ship tier since a PTY is the whole sandbox.
const { canShip } = useRole();
const sandboxRows = computed<readonly AreaRow[]>(() => [
    { id: `capabilities`, to: `/capabilities`, label: `Add a capability`, icon: `plus` },
    ...(canShip.value ? [{ id: `terminal`, to: `/terminal`, label: `Terminal`, icon: `code` } as const] : []),
    { id: `sandbox`, to: `/sandbox`, label: `Sandbox`, icon: `box` },
    { id: `settings`, to: `/settings`, label: `Settings`, icon: `cog` },
]);

// Split so an unreachable sandbox isn't offered beside ones that can actually be switched to.
const switchable = computed(() => connectedSandboxes(sandbox.sandboxes.value));
const unfinished = computed(() => unfinishedSandboxes(sandbox.sandboxes.value));

// A place, so a link; switching sandboxes re-points the daemon, so that stays a button.
const resumeSetup = (id: string) => ({ path: `/setup`, query: { sandbox: id } });

const logout = async (): Promise<void> => {
    await signOut();
    // Full navigation, not a router push: afterSignOut may point outside this SPA.
    globalThis.location.href = environment.afterSignOut;
};
</script>

<template>
    <div class="mx-auto flex w-full max-w-lg flex-col gap-6 p-4">
        <!-- First on the page: the tab's badge is what brought the reader here, one row per pending item. -->
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

        <!-- Quieter ink; none of these carry the tab's badge, so none should read as the reason it's flagged. -->
        <section v-if="sandboxNotes.length > 0" class="flex flex-col gap-1">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Worth knowing</h2>
            <RouterLink
                v-for="item in sandboxNotes"
                :key="item.message"
                :to="item.to"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-sm text-muted transition-colors active:bg-overlay"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center text-subtle">
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
                v-for="option in switchable"
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
                <span v-if="option.role !== 'owner'" class="shrink-0 rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-medium text-subtle"
                    >Shared</span
                >
                <span
                    v-if="option.id === sandbox.activeSandboxId.value"
                    class="h-2 w-2 shrink-0 rounded-full"
                    :class="availabilityVisual.dotClass"
                    :aria-label="availabilityVisual.label"
                ></span>
            </button>
            <RouterLink
                to="/setup"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-left text-sm text-content transition-colors active:bg-overlay"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center"><Icon name="plus" class="text-base text-muted" /></span>
                Add sandbox
            </RouterLink>

            <!-- Same wording as the desktop switcher: offers the move left, not a machine that doesn't exist yet. -->
            <template v-if="unfinished.length > 0">
                <h2 class="mt-2 px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Unfinished setup</h2>
                <RouterLink
                    v-for="option in unfinished"
                    :key="option.id"
                    :to="resumeSetup(option.id)"
                    class="flex h-12 items-center gap-3 rounded-lg px-2 text-left text-sm transition-colors active:bg-overlay"
                >
                    <span class="flex h-8 w-8 shrink-0 items-center justify-center text-subtle"><Icon name="wrench" /></span>
                    <span class="min-w-0 flex-1 truncate text-muted">Finish setting up {{ option.name }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-xs text-subtle" />
                </RouterLink>
            </template>
        </section>

        <!-- The other members connected right now: same roster the desktop rail stacks. -->
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

        <!-- Areas the desktop rail links to, minus the tab bar, grouped into the rail's own bands. -->
        <!--
            A badge's tooltip renders as a second line under the name, never a shrink-0 pill beside it — a
            sentence-length pill would push or truncate the name. A bare count still uses the pill.
        -->
        <section v-for="band in areaBands" :key="band.group.id" class="flex flex-col gap-1">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ band.group.label }}</h2>
            <RouterLink
                v-for="area in band.items"
                :key="area.to"
                :to="area.to"
                class="flex min-h-12 items-center gap-3 rounded-lg px-2 py-1.5 text-sm text-content transition-colors active:bg-overlay"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center">
                    <RailIcon :area="area.id" :fallback="area.icon" :label="area.label" class="text-base text-muted" />
                </span>
                <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-2">
                        <span class="min-w-0 truncate">{{ area.label }}</span>
                        <!-- The count only, when there's no tooltip; min-w-0 shrinks a long number instead of pushing the name off. -->
                        <span
                            v-if="area.badge && area.badge.tooltip === undefined"
                            class="min-w-0 shrink rounded-full px-1.5 py-px text-2xs font-semibold"
                            :class="badgeClass(area.badge)"
                            >{{ area.badge.count }}</span
                        >
                    </span>
                    <span v-if="area.badge?.tooltip !== undefined" class="mt-0.5 block text-xs" :class="badgeToneClass(area.badge)">{{
                        area.badge.tooltip
                    }}</span>
                </span>
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
                <span class="flex h-8 w-8 shrink-0 items-center justify-center">
                    <RailIcon :area="row.id" :fallback="row.icon" :label="row.label" class="text-base text-muted" />
                </span>
                <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
                <Icon name="chevron-right" class="shrink-0 text-xs text-subtle" />
            </RouterLink>
        </section>

        <!-- Account: identity and the actions the desktop avatar popover holds. -->
        <section class="flex flex-col gap-1 pb-4">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Account</h2>
            <div class="flex h-14 items-center gap-3 px-2">
                <Avatar :size="40" :src="user?.image" />
                <span class="min-w-0 flex-1">
                    <span class="truncate text-sm font-medium text-content">{{ user?.email }}</span>
                    <span v-if="user?.name" class="block truncate text-xs text-muted">{{ user.name }}</span>
                </span>
            </div>
            <button
                type="button"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-left text-sm text-content transition-colors active:bg-overlay"
                v-action="logout"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center"><Icon name="sign-out" class="text-base text-muted" /></span>
                Sign out
            </button>
        </section>
    </div>
</template>
