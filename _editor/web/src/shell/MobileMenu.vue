<script setup lang="ts">
import type { SandboxSummary } from "@intentic/api-contract";
import { Avatar, PageHeader, Row, RowGroup, SandboxLogo, vAction } from "@intentic/ui";
import { computed, onMounted } from "vue";
import { useAuth } from "../client/auth/useAuth";
import { useSandboxAttention } from "../features/sandbox/overview/sandboxAttention";
import { useRebuildOffer } from "../features/sandbox/environment/rebuild/useRebuildOffer";
import { identityHue } from "../lib/identityHue";
import { presenceActivity, presenceOthers } from "../workbench/presence/usePresence";
import { useSandbox } from "../client/sandbox/useSandbox";
import { connectedSandboxes, unfinishedSandboxes } from "../models/sandbox/live/roster";
import { sandboxAvailabilityVisual } from "../features/sandbox/overview/availability";
import { placementOf, type SandboxPlacement } from "../features/sandbox/overview/placement";
import { useSandboxPlacement } from "../features/sandbox/overview/useSandboxPlacement";
import { useSandboxAvailability } from "../features/sandbox/overview/useSandboxAvailability";
import { useWorkspaceTree } from "../models/workspace/tree/useWorkspaceTree";
import { leaveAfterSignOut } from "../app/environments/afterSignOut";
import { usePushNotifications } from "../workbench/push/usePushNotifications";
import { pushMenuRow } from "./pushMenuRow";
import MenuRow from "./MenuRow.vue";
import GettingStartedList from "../features/gettingStarted/GettingStartedList.vue";
import { useGettingStarted } from "../features/gettingStarted/useGettingStarted";
import CommunityInvite from "../features/community/CommunityInvite.vue";
import { useCommunityInvite } from "../features/community/useCommunityInvite";
import { useT } from "@intentic/ui/i18n";

// The phone's Menu: what the desktop rail's sandbox switcher and account popover hold, as one page — what the sandbox
// needs, sandbox switching, the presence roster, account actions. Opened from the sandbox's logo atop the phone's rail
// (MobileRail.vue), which holds every section itself, so none is listed here twice. Same state singletons, different
// presentation.

const t = useT();
const tour = useGettingStarted();
const invite = useCommunityInvite();

const sandbox = useSandbox();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityVisual = computed(() => sandboxAvailabilityVisual(availability.value));
const { user, signOut } = useAuth();
// What the rail's sandbox tile badges, one row per item, so the badge that brought the reader here is answered first.
const { needs: sandboxAttention, notes: sandboxNotes } = useSandboxAttention();
// "Rebuild needed" carries its own press where one press is the whole errand (useRebuildOffer); the row still links to
// the card's step, which says why wherever the press is not offered.
const rebuildOffer = useRebuildOffer();
const { offered: rebuildOffered, busy: rebuildBusy, notice: rebuildNotice } = rebuildOffer;

onMounted(() => {
    if (sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
});

// Whether THIS phone can be reached when an agent needs its owner; the settings page does the enabling.
const { state: pushState } = usePushNotifications();
const pushRow = computed(() => pushMenuRow(pushState.value));

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
    leaveAfterSignOut();
};
</script>

<template>
    <!-- Every band is a group of the kit's own rows (MenuRow), the shape a phone's Sandbox and Settings indexes take too, so
         the Menu reads as one list of places in labelled cards rather than a flat run of lines in three type sizes. -->
    <div class="mx-auto w-full max-w-lg p-4">
        <!-- The way back to the board, drawn by the shell (providePageBack), beside the page's name. -->
        <PageHeader :title="t(`shared.menu`)" />
        <div class="flex flex-col gap-6">
            <!-- A first run's checklist, the phone's door to it as the rail's ring is the desktop's: on top while it lasts,
                 since on a first run there is nothing else here yet to put first. -->
            <div v-if="tour.visible.value" class="rounded-xl border border-line bg-card" data-tour="ring">
                <GettingStartedList fill />
            </div>
            <!-- First on the page: the rail's sandbox badge is what brought the reader here, one row per pending item. -->
            <RowGroup v-if="sandboxAttention.length > 0" :label="t(`shared.needs`)">
                <template v-for="item in sandboxAttention" :key="item.message">
                    <MenuRow :to="item.to" :icon="item.icon" :tone="item.tone" :title="item.message" />
                    <MenuRow
                        v-if="item.action === `rebuild` && rebuildOffered"
                        :icon="rebuildBusy ? `spinner` : `bolt`"
                        :tone="rebuildNotice ? `danger` : `default`"
                        :title="t(`sandbox.words.rebuildNow`)"
                        :description="rebuildNotice?.title ?? t(`sandbox.hostedRebuild.buildMinutesCountAgainst`)"
                        @press="rebuildBusy || rebuildOffer.start()"
                    />
                </template>
            </RowGroup>

            <!-- Quieter ink; none of these carry the rail's badge, so none should read as the reason it's flagged. -->
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

            <!-- The community ask, as the desktop account menu has it: once, after the loop, on the visit it is first seen. -->
            <CommunityInvite v-if="invite.note.value" place="phone-note" />
            <!-- Account: identity and the actions the desktop avatar popover holds. -->
            <RowGroup :label="t(`shell.words.account`)" class="pb-4">
                <MenuRow v-if="tour.reopenable.value" icon="circle" :title="t(`gettingStarted.panel.show`)" plain @press="tour.show()" />
                <Row lead="face" :title="user?.email" :description="user?.name ?? undefined">
                    <template #lead="{ mark }"><Avatar :size="mark" :src="user?.image" /></template>
                </Row>
                <MenuRow icon="discord" :title="t(`community.row`)" data-test="community-row" @press="invite.open(`phone-menu`)" />
                <MenuRow v-action="logout" icon="sign-out" :title="t(`shell.words.signOut`)" />
            </RowGroup>
        </div>
    </div>
</template>
