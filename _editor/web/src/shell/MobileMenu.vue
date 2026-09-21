<script setup lang="ts">
import type { SandboxSummary } from "@intentic/api-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { Avatar, type IconName, vAction } from "@intentic/ui";
import { computed, onMounted } from "vue";
import { RouterLink } from "vue-router";
import { useAudience } from "../app/useAudience";
import { useAuth } from "../features/auth/useAuth";
import { useCapabilities } from "../features/capabilities/connect/useCapabilities";
import {
    type ActiveExtension,
    activationBadge,
    sectionReachable,
    detectActivations,
    extensionPath,
    railBands,
    tabBarIds,
    WORKSPACE_VIEW_ID,
} from "../core-views/registry";
import { sandboxHubPath } from "../features/sandbox/sandboxNav";
import { useVocabulary } from "../core-views/vocabulary";
import { badgeChip, badgeClass, badgeToneClass, RUNNING_MARK_CLASS } from "../core-views/viewBadge";
import { usePanels } from "../features/extensions/usePanels";
import { useRole } from "../features/sandbox/secrets/useRole";
import { useSandboxAttention } from "../features/sandbox/overview/sandboxAttention";
import { identityHue } from "../lib/identityHue";
import { presenceActivity, presenceOthers } from "./presence/usePresence";
import { useSandbox } from "../features/sandbox/client/useSandbox";
import { connectedSandboxes, unfinishedSandboxes } from "../features/sandbox/live/roster";
import { sandboxAvailabilityVisual } from "../features/sandbox/overview/availability";
import { placementOf, type SandboxPlacement } from "../features/sandbox/overview/placement";
import { useSandboxPlacement } from "../features/sandbox/overview/useSandboxPlacement";
import { useSandboxAvailability } from "../features/sandbox/overview/useSandboxAvailability";
import { useWorkspaceTree } from "../features/workspace/explorer/useWorkspaceTree";
import { environment } from "../app/environments/environment";
import { usePushNotifications } from "../push/usePushNotifications";
import { pushMenuRow } from "./pushMenuRow";
import RailIcon from "./rail/RailIcon.vue";
import { useT } from "@intentic/ui/i18n";

// The mobile Menu tab: everything the desktop rail and its popovers hold, as one page — sandbox
// switching, the presence roster, the section list, account actions. Same state singletons, different
// presentation.

const t = useT();

interface SectionRow {
    // Groups by railBands, so this page's sections match the desktop rail's runs.
    readonly id: string;
    readonly to: string;
    readonly label: string;
    readonly icon?: IconName;
    // Same shape the rail badges with; spelled out here since there's no hover to show a tooltip on tap.
    readonly badge?: ViewBadge;
}

// Activation.icon is an open string in the extension API, trusted to name an app icon.
const extensionRow = (active: ActiveExtension): SectionRow => {
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

// Whether THIS phone can be reached when an agent needs its owner; the settings page does the enabling.
const { state: pushState } = usePushNotifications();
const pushRow = computed(() => pushMenuRow(pushState.value));

// Same detection and bands as ShellDesktop, but unfiltered by railSeated — no seat scarcity here. The file tree is
// not an extension, so it is stated here: Chat holds the seat it has on the desktop rail's tab bar counterpart.
const words = useVocabulary();
const filesRow = computed<SectionRow>(() => ({ id: WORKSPACE_VIEW_ID, to: `/workspace`, label: words.value.workspace, icon: `folder` }));
const sectionBands = computed(() =>
    railBands(
        [
            filesRow.value,
            ...detectActivations(panels.value, capabilities.value)
                .filter(({ extension }) => extension.surface === `rail` && !tabBarIds().includes(extension.id))
                .map(extensionRow),
        ].filter((section) => sectionReachable(section.to)),
        (section) => section.id,
    ),
);
// Matches the desktop rail's tail (terminal, +); terminal needs ship tier since a PTY is the whole sandbox.
const { canShip, isGuest } = useRole();
const { maker } = useAudience();
// A guest connects nothing and runs no terminal; its Sandbox row opens on the one section it has.
const sandboxRows = computed<readonly SectionRow[]>(() => [
    ...(isGuest.value ? [] : [{ id: `capabilities`, to: `/capabilities`, label: t(`shell.mobileMenu.addCapability`), icon: `plus` } as const]),
    ...(canShip.value && !maker.value ? [{ id: `terminal`, to: `/terminal`, label: t(`shell.mobileMenu.terminal`), icon: `code` } as const] : []),
    { id: `sandbox`, to: sandboxHubPath(isGuest.value), label: t(`shell.mobileMenu.sandbox`), icon: `box` },
    { id: `settings`, to: `/settings`, label: t(`shell.mobileMenu.settings`), icon: `cog` },
]);

// Split so an unreachable sandbox isn't offered beside ones that can actually be switched to.
const switchable = computed(() => connectedSandboxes(sandbox.sandboxes.value));
const unfinished = computed(() => unfinishedSandboxes(sandbox.sandboxes.value));

// Where each box runs. The active row borrows the refined answer (a named device, this very computer); the others
// have only what the platform lists, which still separates Intentic's cloud from hardware of the owner's own.
const placement = useSandboxPlacement();
const placementFor = (option: SandboxSummary): SandboxPlacement =>
    option.id === sandbox.activeSandboxId.value && placement.value !== undefined ? placement.value : placementOf(option);

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
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shell.mobileMenu.needs`) }}</h2>
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
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shell.mobileMenu.worthKnowing`) }}</h2>
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

        <!-- This device, not the sandbox: push is registered per phone, so the ask belongs on the phone's own page. -->
        <section v-if="pushRow !== undefined" class="flex flex-col gap-1">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shell.mobileMenu.phone`) }}</h2>
            <RouterLink
                to="/settings/notifications"
                class="flex min-h-12 items-center gap-3 rounded-lg px-2 py-1.5 text-sm text-content transition-colors active:bg-overlay"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center" :class="pushRow.tone === 'warning' ? 'text-warning' : 'text-link'">
                    <Icon name="bolt" class="text-base" />
                </span>
                <span class="min-w-0 flex-1">
                    <span class="block text-xs">{{ pushRow.message }}</span>
                    <span class="mt-0.5 block text-xs text-muted">{{ pushRow.detail }}</span>
                </span>
                <Icon name="chevron-right" class="shrink-0 text-xs text-subtle" />
            </RouterLink>
        </section>

        <!-- Sandboxes: tap to switch; the active one shows its live status dot. -->
        <section class="flex flex-col gap-1">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shell.mobileMenu.sandboxes`) }}</h2>
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
                <!-- Same mark, same meaning as the desktop rail's tile: which machine this box is on. No tooltip on a
                     phone, so the sentence is the icon's own label and the row reads it out in full. -->
                <Icon
                    v-if="placementFor(option).kind !== 'shared'"
                    :name="placementFor(option).icon"
                    class="shrink-0 text-xs text-subtle"
                    :aria-label="placementFor(option).detail"
                />
                <span v-if="option.role !== 'owner'" class="ui-status-pill shrink-0 bg-content/10 text-2xs font-medium text-subtle">{{
                    t(`shell.mobileMenu.shared`)
                }}</span>
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
                {{ t(`shell.mobileMenu.addSandbox`) }}
            </RouterLink>

            <!-- Same wording as the desktop switcher: offers the move left, not a machine that doesn't exist yet. -->
            <template v-if="unfinished.length > 0">
                <h2 class="mt-2 px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shell.mobileMenu.unfinishedSetup`) }}</h2>
                <RouterLink
                    v-for="option in unfinished"
                    :key="option.id"
                    :to="resumeSetup(option.id)"
                    class="flex h-12 items-center gap-3 rounded-lg px-2 text-left text-sm transition-colors active:bg-overlay"
                >
                    <span class="flex h-8 w-8 shrink-0 items-center justify-center text-subtle"><Icon name="wrench" /></span>
                    <span class="min-w-0 flex-1 truncate text-muted">{{ t(`shell.mobileMenu.finishSettingUp`, { name: option.name }) }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-xs text-subtle" />
                </RouterLink>
            </template>
        </section>

        <!-- The other members connected right now: same roster the desktop rail stacks. -->
        <section v-if="presenceOthers.length > 0" class="flex flex-col gap-2">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shell.mobileMenu.hereNow`) }}</h2>
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
                        <span class="block truncate text-xs text-muted"
                            >{{ presenceActivity(member) }}{{ member.idle ? t(`shell.mobileMenu.away`) : "" }}</span
                        >
                    </span>
                </div>
            </div>
        </section>

        <!-- Sections the desktop rail links to, minus the tab bar, grouped into the rail's own bands. -->
        <!-- A badge's tooltip renders as a second line under the name, never a shrink-0 pill beside it — a sentence-length pill would push or truncate the name. -->
        <section v-for="band in sectionBands" :key="band.group.id" class="flex flex-col gap-1">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ band.group.label }}</h2>
            <RouterLink
                v-for="section in band.items"
                :key="section.to"
                :to="section.to"
                class="flex min-h-12 items-center gap-3 rounded-lg px-2 py-1.5 text-sm text-content transition-colors active:bg-overlay"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center">
                    <RailIcon :section="section.id" :fallback="section.icon" :label="section.label" class="text-base text-muted" />
                </span>
                <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-2">
                        <span class="min-w-0 truncate">{{ section.label }}</span>
                        <!-- The count only, when there's no tooltip; min-w-0 shrinks a long number instead of pushing the name off. -->
                        <span
                            v-if="section.badge && badgeChip(section.badge) && section.badge.tooltip === undefined"
                            class="ui-status-pill min-w-0 shrink text-2xs font-semibold"
                            :class="badgeClass(section.badge)"
                            >{{ section.badge.count }}</span
                        >
                    </span>
                    <span v-if="section.badge?.tooltip !== undefined" class="mt-0.5 block text-xs" :class="badgeToneClass(section.badge)">{{
                        section.badge.tooltip
                    }}</span>
                    <!-- Running gets a line of its own rather than the rail's corner mark: a row this wide can afford the sentence. -->
                    <span v-if="section.badge?.running !== undefined" class="mt-0.5 flex items-center gap-1 text-xs" :class="RUNNING_MARK_CLASS">
                        <Icon name="spinner" spin />{{ section.badge.running }}
                    </span>
                </span>
                <Icon name="chevron-right" class="shrink-0 text-xs text-subtle" />
            </RouterLink>
        </section>

        <!-- The box rather than the work, matching what the desktop rail keeps below its last divider. -->
        <section class="flex flex-col gap-1">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shell.mobileMenu.sandbox`) }}</h2>
            <RouterLink
                v-for="row in sandboxRows"
                :key="row.to"
                :to="row.to"
                class="flex h-12 items-center gap-3 rounded-lg px-2 text-sm text-content transition-colors active:bg-overlay"
            >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center">
                    <RailIcon :section="row.id" :fallback="row.icon" :label="row.label" class="text-base text-muted" />
                </span>
                <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
                <Icon name="chevron-right" class="shrink-0 text-xs text-subtle" />
            </RouterLink>
        </section>

        <!-- Account: identity and the actions the desktop avatar popover holds. -->
        <section class="flex flex-col gap-1 pb-4">
            <h2 class="px-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shell.mobileMenu.account`) }}</h2>
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
                {{ t(`shell.mobileMenu.signOut`) }}
            </button>
        </section>
    </div>
</template>
