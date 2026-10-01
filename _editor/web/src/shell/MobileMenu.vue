<script setup lang="ts">
import type { SandboxSummary } from "@intentic/api-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { Avatar, type IconName, Row, RowGroup, SandboxLogo, vAction } from "@intentic/ui";
import { computed, onMounted } from "vue";
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
    DEVICES_VIEW_ID,
} from "../core-views/registry";
import { sandboxHubPath } from "../features/sandbox/sandboxNav";
import { DEVICES_PATH } from "../features/sandbox/devices/deviceLinks";
import { devicesWorking } from "../features/sandbox/devices/runners/deviceWork";
import { useVocabulary } from "../core-views/vocabulary";
import { badgeChip, badgeClass, badgeToneClass, RUNNING_MARK_CLASS } from "../core-views/viewBadge";
import { usePanels } from "../features/extensions/usePanels";
import { useRole } from "../features/sandbox/secrets/useRole";
import { useInbox } from "../features/needs/inbox/useInbox";
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
import MenuRow from "./MenuRow.vue";
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
// The one row to everything waiting on a person, with what it counts said on the row, since a phone has no hover.
const { badge: inboxBadge } = useInbox();

onMounted(() => {
    if (sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
});

// Whether THIS phone can be reached when an agent needs its owner; the settings page does the enabling.
const { state: pushState } = usePushNotifications();
const pushRow = computed(() => pushMenuRow(pushState.value));

const { canShip, isGuest } = useRole();
// The machines this sandbox reaches, turning while one of them is being worked on (devices/runners/deviceWork.ts).
const devicesRow = computed<SectionRow>(() => {
    const running = devicesWorking();
    const row: SectionRow = { id: DEVICES_VIEW_ID, to: DEVICES_PATH, label: t(`sandbox.words.devicesSection`), icon: `desktop` };
    return running === undefined ? row : { ...row, badge: { running } };
});
// Same detection and bands as ShellDesktop, but unfiltered by onRail — no tile scarcity here. The file tree is
// not an extension, so it is stated here: Chat holds the tile it has on the desktop rail's tab bar counterpart.
const words = useVocabulary();
const filesRow = computed<SectionRow>(() => ({ id: WORKSPACE_VIEW_ID, to: `/workspace`, label: words.value.workspace, icon: `folder` }));
const sectionBands = computed(() =>
    railBands(
        [
            filesRow.value,
            // A view of its own, off the hub, so a phone reaches it here as the desktop reaches it from its rail tile.
            ...(canShip.value ? [devicesRow.value] : []),
            ...detectActivations(panels.value, capabilities.value)
                .filter(({ extension }) => extension.surface === `rail` && !tabBarIds().includes(extension.id))
                .map(extensionRow),
        ].filter((section) => sectionReachable(section.to)),
        (section) => section.id,
    ),
);
// Matches the desktop rail's tail (terminal, +); terminal needs ship tier since a PTY is the whole sandbox.
const { maker } = useAudience();
// A guest connects nothing and runs no terminal; its Sandbox row opens on the one section it has.
const sandboxRows = computed<readonly SectionRow[]>(() => [
    ...(isGuest.value ? [] : [{ id: `capabilities`, to: `/capabilities`, label: t(`shell.words.addCapability`), icon: `plus` } as const]),
    ...(canShip.value && !maker.value ? [{ id: `terminal`, to: `/terminal`, label: t(`shared.terminal`), icon: `code` } as const] : []),
    { id: `sandbox`, to: sandboxHubPath(isGuest.value), label: t(`shared.sandboxHub`), icon: `box` },
    { id: `settings`, to: `/settings`, label: t(`shared.settings`), icon: `cog` },
]);

// Split so an unreachable sandbox isn't offered beside ones that can actually be switched to.
const switchable = computed(() => connectedSandboxes(sandbox.sandboxes.value));
const unfinished = computed(() => unfinishedSandboxes(sandbox.sandboxes.value));

// Where each box runs. The active row borrows the refined answer (a named device, this very computer); the others
// have only what the platform lists, which still separates Intentic's cloud from hardware of the owner's own.
const placement = useSandboxPlacement();
const isActive = (option: SandboxSummary): boolean => option.id === sandbox.activeSandboxId.value;
const placementFor = (option: SandboxSummary): SandboxPlacement =>
    isActive(option) && placement.value !== undefined ? placement.value : placementOf(option);

// A place, so a link; switching sandboxes re-points the daemon, so that stays a button.
const resumeSetup = (id: string) => ({ path: `/setup`, query: { sandbox: id } });

const logout = async (): Promise<void> => {
    await signOut();
    // Full navigation, not a router push: afterSignOut may point outside this SPA.
    globalThis.location.href = environment.afterSignOut;
};
</script>

<template>
    <!-- Every band is a group of the kit's own rows (MenuRow), the shape a phone's Sandbox and Settings indexes take too, so
         the Menu reads as one list of places in labelled cards rather than a flat run of lines in three type sizes. -->
    <div class="mx-auto flex w-full max-w-lg flex-col gap-6 p-4">
        <!-- First on the page: the tab's badge is what brought the reader here, one row per pending item. -->
        <RowGroup v-if="inboxBadge !== undefined || sandboxAttention.length > 0" :label="t(`shared.needs`)">
            <MenuRow
                v-if="inboxBadge !== undefined"
                to="/needs"
                icon="exclamation-circle"
                :tone="inboxBadge.tone === `danger` ? `danger` : `warning`"
                :title="t(`needs.inbox.title`)"
                :description="inboxBadge.tooltip"
            />
            <MenuRow v-for="item in sandboxAttention" :key="item.message" :to="item.to" :icon="item.icon" :tone="item.tone" :title="item.message" />
        </RowGroup>

        <!-- Quieter ink; none of these carry the tab's badge, so none should read as the reason it's flagged. -->
        <RowGroup v-if="sandboxNotes.length > 0" :label="t(`shared.worthKnowing`)">
            <MenuRow v-for="item in sandboxNotes" :key="item.message" :to="item.to" :icon="item.icon">
                <template #title><span class="font-normal text-muted">{{ item.message }}</span></template>
            </MenuRow>
        </RowGroup>

        <!-- This device, not the sandbox: push is registered per phone, so the ask belongs on the phone's own page. -->
        <RowGroup v-if="pushRow !== undefined" :label="t(`shell.mobileMenu.phone`)">
            <MenuRow to="/settings/notifications" icon="bolt" :tone="pushRow.tone" :title="pushRow.message" :description="pushRow.detail" />
        </RowGroup>

        <!-- Sandboxes: tap to switch; the active one's placement mark carries its live status. -->
        <RowGroup :label="t(`shared.sandboxes`)">
            <MenuRow v-for="option in switchable" :key="option.id" :selected="isActive(option)" @press="sandbox.select(option.id)">
                <template #lead="{ mark }"><SandboxLogo :size="mark" :image="option.image ?? null" :name="option.name" /></template>
                <template #title>
                    <span :class="isActive(option) ? 'text-link' : ''">{{ option.name }}</span>
                </template>
                <template #meta>
                    <!-- Same mark, same meaning as the desktop rail's tile: which machine this box is on, inked on the
                         active row by whether that machine answers. Drawn there even under a "Shared" pill, which says
                         whose the box is and not whether it is up. No tooltip on a phone, so the sentence is the icon's
                         own label and the row reads it out in full. -->
                    <Icon
                        v-if="isActive(option) || placementFor(option).kind !== 'shared'"
                        :name="placementFor(option).icon"
                        class="shrink-0 text-xs"
                        :class="isActive(option) ? availabilityVisual.inkClass : 'text-subtle'"
                        :aria-label="isActive(option) ? `${placementFor(option).detail} · ${availabilityVisual.label}` : placementFor(option).detail"
                    />
                    <span v-if="option.role !== 'owner'" class="ui-status-pill shrink-0 bg-content/10 text-2xs font-medium text-subtle">{{
                        t(`shared.shared`)
                    }}</span>
                </template>
            </MenuRow>
            <MenuRow to="/setup" icon="plus" :title="t(`sandbox.words.addSandbox`)" plain />
        </RowGroup>

        <!-- Same wording as the desktop switcher: offers the move left, not a machine that doesn't exist yet. -->
        <RowGroup v-if="unfinished.length > 0" :label="t(`shared.unfinishedSetup`)">
            <MenuRow
                v-for="option in unfinished"
                :key="option.id"
                :to="resumeSetup(option.id)"
                icon="wrench"
                :title="t(`sandbox.words.finishSettingUp`, { name: option.name })"
            />
        </RowGroup>

        <!-- The other members connected right now: same roster the desktop rail stacks. -->
        <RowGroup v-if="presenceOthers.length > 0" :label="t(`shared.hereNow`)">
            <Row
                v-for="member in presenceOthers"
                :key="member.email"
                lead="face"
                :title="member.name ?? member.email"
                :description="`${presenceActivity(member)}${member.idle ? t(`shell.mobileMenu.away`) : ``}`"
            >
                <template #lead="{ mark }">
                    <Avatar :size="mark" :name="member.name ?? member.email" :src="member.picture" :hue="identityHue(member.email)" :idle="member.idle" />
                </template>
            </Row>
        </RowGroup>

        <!-- Sections the desktop rail links to, minus the tab bar, grouped into the rail's own bands. -->
        <!-- A badge's tooltip renders as a second line under the name, never a shrink-0 pill beside it — a sentence-length pill would push or truncate the name. -->
        <RowGroup v-for="band in sectionBands" :key="band.group.id" :label="band.group.label">
            <MenuRow v-for="section in band.items" :key="section.to" :to="section.to">
                <template #lead="{ iconClass }">
                    <RailIcon :section="section.id" :fallback="section.icon" :label="section.label" :class="[iconClass, 'shrink-0 text-muted']" />
                </template>
                <template #title>
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
                </template>
                <template v-if="section.badge?.tooltip !== undefined || section.badge?.running !== undefined" #description>
                    <span v-if="section.badge?.tooltip !== undefined" class="block" :class="badgeToneClass(section.badge)">{{ section.badge.tooltip }}</span>
                    <!-- Running gets a line of its own rather than the rail's corner mark: a row this wide can afford the sentence. -->
                    <span v-if="section.badge?.running !== undefined" class="flex items-center gap-1" :class="RUNNING_MARK_CLASS">
                        <Icon name="spinner" spin />{{ section.badge.running }}
                    </span>
                </template>
            </MenuRow>
        </RowGroup>

        <!-- The box rather than the work, matching what the desktop rail keeps below its last divider. -->
        <RowGroup :label="t(`shared.sandboxHub`)">
            <MenuRow v-for="row in sandboxRows" :key="row.to" :to="row.to" :title="row.label">
                <template #lead="{ iconClass }">
                    <RailIcon :section="row.id" :fallback="row.icon" :label="row.label" :class="[iconClass, 'shrink-0 text-muted']" />
                </template>
            </MenuRow>
        </RowGroup>

        <!-- Account: identity and the actions the desktop avatar popover holds. -->
        <RowGroup :label="t(`shell.words.account`)" class="pb-4">
            <Row lead="face" :title="user?.email" :description="user?.name ?? undefined">
                <template #lead="{ mark }"><Avatar :size="mark" :src="user?.image" /></template>
            </Row>
            <MenuRow v-action="logout" icon="sign-out" :title="t(`shell.words.signOut`)" />
        </RowGroup>
    </div>
</template>
