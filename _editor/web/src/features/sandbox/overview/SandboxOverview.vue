<script setup lang="ts">
import { platformHealth } from "../../../lib/platform/platformHealth";
import { directMode } from "../../../client/directory/directState";
import {
    AnchoredOverlay,
    Button,
    Card,
    CopyButton,
    InlineRename,
    resourcesSummary,
    SandboxLogo,
    SandboxResourcesDialog,
    StatusBadge,
    toneHover,
    ui,
    vAction,
} from "@intentic/ui";
import type { ResourcesForm } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import type { SandboxSummary } from "@intentic/api-contract";
import { SANDBOX_NAME_MAX } from "@intentic/constants";
import { computed, ref } from "vue";
import { fileToSquareDataUrl, fileToSvgDataUrl } from "../../../lib/imageDataUrl";
import { useSandboxVersion } from "../../../models/sandbox/useSandboxVersion";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { sandboxHoursLine } from "../../../models/hosted-plan/hostedHours";
import { useHostedPlan } from "../../../models/hosted-plan/useHostedPlan";
import { sandboxAvailabilityVisual } from "./availability";
import { useSandboxAvailability } from "./useSandboxAvailability";
import { useSandboxPlacement } from "./useSandboxPlacement";
import { useWorkspaceTree } from "../../../models/workspace/tree/useWorkspaceTree";
import { useSelfResources } from "../../../models/sandbox/devices/useSelfResources";
import { useRole } from "../../../client/sandbox/useRole";
import SandboxBackupCard from "./backup/SandboxBackupCard.vue";
import SandboxBehindCard from "./version/SandboxBehindCard.vue";
import SandboxManifestCard from "./manifest/SandboxManifestCard.vue";
import OverviewSettingRow from "./OverviewSettingRow.vue";
import { EDITABLE_VALUE, FIXED_VALUE } from "./overviewLook";
import SandboxFenceRow from "./SandboxFenceRow.vue";
import SandboxSleepRow from "./SandboxSleepRow.vue";
import SandboxGpuRow from "./SandboxGpuRow.vue";
import SandboxModeRow from "./mode/SandboxModeRow.vue";
import SandboxStorageCard from "./storage/SandboxStorageCard.vue";
import SandboxUpdateCard from "./version/SandboxUpdateCard.vue";
import SandboxLogoStyleDialog from "./logo/SandboxLogoStyleDialog.vue";
import { useT } from "@intentic/ui/i18n";
import { ADD_SANDBOX_HOME_PATH } from "../../../models/sandbox/addSandbox";
import { askRemoveSandbox } from "../../../models/sandbox/removeSandbox";
import { here, page } from "../../../lib/routes/links";

// Overview tab: sandbox identity (name, logo), self-reported image/version/URL relayed live via /info, and the
// non-blocking update prompt. Excludes per-tab status links or a running list: those duplicate badges and panels
// that already live elsewhere (rail, tab badges, Preview/Ports).

const t = useT();

const sandbox = useSandbox();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityBadge = computed(() => sandboxAvailabilityVisual(availability.value));
// The happy path needs no badge: reaching this tab already means the sandbox is up.
const showAvailabilityBadge = computed(() => availability.value !== `live` && availability.value !== `stale`);
const { info, installed, latest, updateAvailable } = useSandboxVersion();

const isOwner = computed(() => sandbox.active.value?.role === `owner`);
// The name and the logo are the owner's and Full access's to change (the platform's `requireFullAccess`).
// (2026-11-09) Both live on the platform, so neither is offered while it isn't answering or the window is open without
// it: the name and logo show as they are, and the status bar's offline chip says why (PlatformStatusChip.vue).
const platformAnswering = computed(() => !platformHealth.down.value && !directMode.value);
const canEditIdentity = computed(() => platformAnswering.value && (isOwner.value || sandbox.active.value?.role === `maintainer`));
const agentUrl = computed(() => sandbox.daemonUrl.value ?? undefined);
// Platform-hosted (starter) sandbox; the upgrade card below keys on this.
const hosted = computed(() => (sandbox.active.value?.hosted ?? null) !== null);
// Which machine this sandbox stands on, said in words beside its name.
const placement = useSandboxPlacement();
// The hours THIS sandbox's machine spends, in the sentence Billing and the chat strip use for it: its own month on a
// paid slot, or the account's free hours.
const { state: hostedPlan, offered: planOffered } = useHostedPlan();
const machineStanding = computed(() => sandboxHoursLine(hostedPlan.value, sandbox.active.value?.id));
// Whether that machine is the free one: only it is a "small starter machine", and a paid rung is not to be called one.
const starterMachine = computed(() => {
    const lane = hostedPlan.value?.hosted;
    const machine = lane?.machines.find((row) => row.sandboxId === sandbox.active.value?.id);
    return machine === undefined || machine.tier === lane?.freeTier.id;
});

// THIS SANDBOX'S SHARE OF ITS MACHINE, beside the image and the URL it already reports. The Devices tab can change
// it too, but only for a reader who knows which machine to open first; this is the same form reached from the facts
// about the sandbox itself. Self-hides when its machine is not a connected device — there is no door to send a
// reshape through, and a row saying so would be a row about somebody else's problem.
const selfResources = useSelfResources();
// Changing that share is a device op, maintainer and up at the daemon (`manageDeviceSandbox`), so it reads `canShip`;
// the name and the logo read `canEditIdentity` (owner or Full access at the platform), and the hosted card `isOwner`,
// since it goes to the platform's owner-only routes.
const { canShip } = useRole();
const shareLine = computed(() => (selfResources.row.value === undefined ? undefined : resourcesSummary(selfResources.row.value)));
const resizing = ref(false);
// The sandbox recreates under this page, so success is the reconnect, not a sentence here. Only a refusal the machine
// actually sent has anything to say, and it is the composable's, so the chat's memory notice shows the same one.
const resizeFailed = computed(() => {
    const failure = selfResources.failure.value;
    return failure === undefined ? undefined : (failure.detail ?? failure.title);
});
// What the row says in place of its button while a reshape runs, from whichever surface started it.
const resizePending = computed(() => {
    const pending = selfResources.pending.value;
    if (pending === undefined) {
        return undefined;
    }
    return pending === `apply` ? t(`sandbox.sandboxOverview.resizeRestarting`) : t(`sandbox.sandboxOverview.resizeSaving`);
});
const applyResize = async (shape: ResourcesForm): Promise<void> => {
    resizing.value = false;
    await selfResources.apply(shape);
};
// Saving leaves the sandbox running, so unlike Apply this one answers: the share line picks up "changes on restart".
const saveResize = async (shape: ResourcesForm | undefined): Promise<void> => {
    resizing.value = false;
    await selfResources.save(shape);
};

// The name renames itself in place (<InlineRename>, owner and Full access). The logo is separate and live at all times;
// picking a file saves immediately (`pickFile`), no commit step needed.
const fileInput = ref<HTMLInputElement | null>(null);
const logoError = ref<string | undefined>(undefined);

// The menu offers an upload or presets even before an image has been set.
const logoTrigger = ref<HTMLButtonElement | null>(null);
const logoMenuOpen = ref(false);
const logoBusy = ref(false);
const logo = computed(() => sandbox.active.value?.image ?? undefined);
const stylingSandbox = ref<SandboxSummary>();

// One line under the title, for the logo's own report and the sandbox's standing. The rename says nothing here:
// it carries its own state inside its own box, so entering and leaving edit mode cannot move this card.
const subline = computed<{ text: string; tone: string }>(() => {
    if (logoError.value !== undefined) {
        return { text: logoError.value, tone: `text-danger` };
    }
    if (availability.value === `busy`) {
        return { text: t(`sandbox.sandboxOverview.busyLiveActionsResume`), tone: `text-muted` };
    }
    if (availability.value === `unreachable`) {
        return { text: t(`sandbox.sandboxOverview.notRespondingLiveActions`), tone: `text-muted` };
    }
    if (availability.value === `starting` || availability.value === `warming`) {
        return { text: t(`sandbox.sandboxOverview.gettingWorkspaceReady`), tone: `text-muted` };
    }
    return { text: ``, tone: `text-muted` };
});

// The name goes straight to the platform; the row's cache write is what redraws this card and the rail chip.
const writeName = async (name: string): Promise<void> => {
    const id = sandbox.active.value?.id;
    if (id === undefined) {
        return;
    }
    await sandbox.update(id, { name });
};

const pressLogo = (): void => {
    logoError.value = undefined;
    logoMenuOpen.value = !logoMenuOpen.value;
};

// Writes the logo directly; `null` clears it. `sandbox.update`'s cache write updates this tile and the rail chip
// together.
const writeLogo = async (image: string | null): Promise<void> => {
    const id = sandbox.active.value?.id;
    if (id === undefined) {
        return;
    }
    logoBusy.value = true;
    logoError.value = undefined;
    try {
        await sandbox.update(id, { image });
    } catch (err) {
        logoError.value = messageOr(err, t(`sandbox.sandboxOverview.couldntSaveLogo`));
    } finally {
        logoBusy.value = false;
    }
};

const pickFile = async (event: Event): Promise<void> => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ``;
    if (file === undefined) {
        return;
    }
    logoError.value = undefined;
    // SVGs stay as vector data URLs; everything else is downscaled to a WebP square. Contained, not cropped, since a
    // centre slice of a wordmark loses it; a failed read is a file error, not a save error.
    let square: string;
    try {
        square = file.type === `image/svg+xml` ? await fileToSvgDataUrl(file) : await fileToSquareDataUrl(file, `contain`);
    } catch {
        logoError.value = t(`sandbox.sandboxOverview.couldntReadImage`);
        return;
    }
    await writeLogo(square);
};

// Each action dismisses the menu before opening its next control.
const changeLogo = (): void => {
    logoMenuOpen.value = false;
    fileInput.value?.click();
};

const removeLogo = async (): Promise<void> => {
    logoMenuOpen.value = false;
    await writeLogo(null);
};

const stylizeLogo = (): void => {
    logoMenuOpen.value = false;
    stylingSandbox.value = sandbox.active.value;
};

// REMOVING OR LEAVING THIS SANDBOX, at the foot of its own page: where a reader who means it looks for it, and away from
// the switcher's rows, which a pointer sweeps on its way to switching. The question and the work are the shell's one
// dialog (models/sandbox/removeSandbox.ts), which outlives this page: removing the sandbox on screen switches to another.
// The line under the heading is the dialog's own first sentence, so the press holds no surprise.
const removeLead = computed(() => {
    if (!isOwner.value) {
        return t(`sandbox.removeAsk.leadLeave`);
    }
    return hosted.value ? t(`sandbox.removeAsk.leadHosted`) : t(`sandbox.removeAsk.leadOwn`);
});
const askRemove = (): void => {
    const row = sandbox.active.value;
    if (row !== undefined) {
        askRemoveSandbox(row);
    }
};

// The dialog keeps the sandbox it opened for, even if the active sandbox changes during the edit.
const saveStyledLogo = async (image: string): Promise<void> => {
    const target = stylingSandbox.value;
    if (target !== undefined) {
        await sandbox.update(target.id, { image });
    }
};
</script>

<template>
    <div class="@container flex flex-col gap-6">
        <!-- Identity: name + logo (owner and Full access edit them), self-reported image/version/URL. -->
        <Card data-setting="overview-name" class="flex flex-col gap-4">
            <div class="flex flex-col gap-3 @2xl:flex-row @2xl:items-center @2xl:justify-between">
                <div class="flex min-w-0 flex-1 items-center gap-3">
                    <!-- The logo tile is the control itself for the owner and Full access, in every state; anyone else sees the logo alone. -->
                    <SandboxLogo v-if="!canEditIdentity" :size="48" :image="logo ?? null" :name="sandbox.active.value?.name" class="shrink-0" />
                    <!-- allow(recipes): THE OVERVIEW HEADING'S 48px SANDBOX LOGO is the button: its box is the logo's
                         (SandboxLogo :size="48"), drawn nowhere else, not a glyph at any of the recipe's sizes, and
                         its width is the logo's too. -->
                    <button
                        v-else
                        ref="logoTrigger"
                        type="button"
                        :disabled="logoBusy"
                        aria-haspopup="dialog"
                        :aria-expanded="logoMenuOpen"
                        :aria-label="logo ? t(`sandbox.sandboxOverview.changeRemoveLogo`) : t(`sandbox.sandboxOverview.addLogo`)"
                        v-tooltip.bottom="logo ? t(`sandbox.sandboxOverview.logoChange`) : t(`sandbox.sandboxOverview.logoAdd`)"
                        :class="ui.iconButton(`group h-12 w-12 overflow-hidden`)"
                        @click="pressLogo"
                    >
                        <SandboxLogo :size="48" :image="logo ?? null" :name="sandbox.active.value?.name" />
                        <span
                            class="absolute inset-0 flex items-center justify-center bg-canvas/70 text-content transition-opacity"
                            :class="logoBusy ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'"
                        >
                            <Icon :name="logoBusy ? `spinner` : `image`" :spin="logoBusy" class="text-base" />
                        </span>
                    </button>
                    <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="pickFile" />

                    <AnchoredOverlay v-model="logoMenuOpen" :anchor="logoTrigger ?? undefined" side="bottom" cross="start">
                        <div class="flex w-44 flex-col gap-0.5">
                            <button
                                type="button"
                                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-content transition-colors hover:bg-content/5"
                                @click="stylizeLogo"
                            >
                                <Icon name="palette" class="shrink-0 text-sm text-muted" />{{ t(`sandbox.logoStyle.menu`) }}
                            </button>
                            <button
                                type="button"
                                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-content transition-colors hover:bg-content/5"
                                @click="changeLogo"
                            >
                                <Icon name="image" class="shrink-0 text-sm text-muted" />{{
                                    logo ? t(`sandbox.sandboxOverview.changeLogo`) : t(`sandbox.logoStyle.upload`)
                                }}
                            </button>
                            <button
                                v-if="logo"
                                type="button"
                                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-danger transition-colors"
                                :class="toneHover(`danger`)"
                                v-action="removeLogo"
                            >
                                <Icon name="trash" class="shrink-0 text-sm" />{{ t(`sandbox.sandboxOverview.removeLogo`) }}
                            </button>
                        </div>
                    </AnchoredOverlay>

                    <SandboxLogoStyleDialog
                        v-if="stylingSandbox"
                        :name="stylingSandbox.name"
                        :image="stylingSandbox.image"
                        :write="saveStyledLogo"
                        @close="stylingSandbox = undefined"
                    />

                    <div class="-ml-1 min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <!-- The card's heading IS the rename: text at rest, a field in the same box, nothing added beside it.
                                 It stays an <h2> around that, so renaming the sandbox doesn't cost the card its heading. -->
                            <h2 class="flex min-w-0 text-lg font-semibold @2xl:max-w-md">
                                <InlineRename
                                    :value="sandbox.active.value?.name"
                                    :write="writeName"
                                    :label="t(`sandbox.sandboxOverview.sandboxName`)"
                                    :action="t(`sandbox.sandboxOverview.renameSandbox`)"
                                    fallback="Sandbox"
                                    :editable="canEditIdentity"
                                    :maxlength="SANDBOX_NAME_MAX"
                                    failure="Couldn't save the sandbox's name."
                                />
                            </h2>
                            <StatusBadge
                                v-if="showAvailabilityBadge"
                                class="shrink-0"
                                :variant="availabilityBadge.variant"
                                :label="availabilityBadge.label"
                                dot
                            />
                            <!-- Which image it runs and the version installed in it, said once beside the name it belongs to.
                                 Never cut: a tag is read to its last character, so a long one wraps onto a line of its own. -->
                            <span
                                v-if="sandbox.reachable.value && (info?.image || installed)"
                                data-overview="image"
                                class="flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono text-xs text-muted"
                            >
                                <span v-if="info?.image" class="min-w-0 [overflow-wrap:anywhere]">{{ info.image }}</span>
                                <span v-if="installed" class="min-w-0 text-subtle [overflow-wrap:anywhere]">
                                    {{ t(`sandbox.sandboxOverview.installedVersion`) }} {{ installed }}
                                    <span v-if="updateAvailable" class="text-warning">{{ t(`sandbox.sandboxOverview.available`, { latest }) }}</span>
                                </span>
                            </span>
                        </div>
                        <p v-if="subline.text" class="h-4 truncate px-1 text-xs leading-4" :class="subline.tone">{{ subline.text }}</p>
                    </div>
                </div>
            </div>

            <!-- What the sandbox reports about itself, relayed via /info and never stored by the platform. Its one wait, the
                 first read, is the hub section's own (lazySection), which holds this page's last look until /info answers.
                 Two lists, told apart by what a reader does with them: what can be changed, where each value is itself
                 the press that changes it, and what is only read. Side by side with room, stacked against a narrow pane. -->
            <div
                v-if="sandbox.reachable.value && (info?.image || installed || agentUrl)"
                class="grid gap-x-6 gap-y-5 border-t border-line-subtle pt-4 @xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
            >
                <section class="flex min-w-0 flex-col gap-2">
                    <h3 class="text-xs font-medium text-content">{{ t(`shared.settings`) }}</h3>
                    <dl data-overview="settings" class="flex flex-col divide-y divide-line-subtle">
                        <!-- First: how it runs decides what the rest of the app asks of the reader (overview/mode/SandboxModeRow.vue). -->
                        <SandboxModeRow />
                        <!-- Its share of the machine, and the one form that changes it. Maintainer and up: acting on a device is
                             maintainer-floored at the daemon, so a member below that gets the fact without a press that would refuse. -->
                        <OverviewSettingRow v-if="shareLine" data-setting="overview-resources" :label="t(`sandbox.sandboxOverview.resources`)">
                            <!-- In flight, the press gives way to what it set going: a value that still looked
                                 pressable answered nothing for the seconds before the sandbox drops. -->
                            <button v-if="canShip && resizePending === undefined" type="button" :class="EDITABLE_VALUE" @click="resizing = true">
                                <span class="flex min-w-0 items-baseline gap-1.5">
                                    <span class="min-w-0 break-words">{{ shareLine }}</span>
                                    <Icon name="pencil" class="shrink-0 text-2xs text-subtle opacity-60 transition-opacity group-hover/value:opacity-100" aria-hidden="true" />
                                </span>
                                <span class="sr-only">{{ t(`sandbox.sandboxOverview.change`) }}</span>
                            </button>
                            <span v-else :class="FIXED_VALUE">{{ shareLine }}</span>
                            <span
                                v-if="canShip && resizePending !== undefined"
                                role="status"
                                data-testid="overview-resize-pending"
                                class="inline-flex items-center gap-1.5 text-subtle"
                            >
                                <Icon name="spinner" spin class="shrink-0" aria-hidden="true" />{{ resizePending }}
                            </span>
                            <p v-if="resizeFailed !== undefined" class="text-warning">{{ resizeFailed }}</p>
                        </OverviewSettingRow>
                        <!-- Whether the machine it stands on may put it to sleep while nobody needs it; self-hides for a hosted one. -->
                        <SandboxSleepRow />
                        <!-- Who may use the host GPU, and GPU work paused after the host reported a GPU reset; self-hides without one. -->
                        <SandboxGpuRow />
                        <!-- What it may reach on the networks around that machine; says a hosted one has none to fence. -->
                        <SandboxFenceRow />
                    </dl>
                </section>

                <section class="flex min-w-0 flex-col gap-2 @xl:border-l @xl:border-line-subtle @xl:pl-6">
                    <h3 class="text-xs font-medium text-content">{{ t(`sandbox.sandboxOverview.details`) }}</h3>
                    <dl data-overview="details" class="flex flex-col divide-y divide-line-subtle">
                        <!-- The rail's corner mark, in words. The glyph up there is a glance; this is the page a reader
                             opens to find out what it meant, so it spells the machine out and the tooltip carries the
                             name that refines it (a region, a host), where there is one. -->
                        <OverviewSettingRow v-if="placement" data-overview="placement" stacked :label="t(`sandbox.sandboxOverview.runsOn`)">
                            <span
                                :class="FIXED_VALUE"
                                class="!flex-row items-baseline gap-1.5 [overflow-wrap:anywhere]"
                                v-tooltip.top="placement.tip.rows === undefined ? undefined : placement.tip"
                            >
                                <Icon :name="placement.icon" class="shrink-0 text-2xs text-subtle" />{{ placement.label }}
                            </span>
                        </OverviewSettingRow>
                        <OverviewSettingRow v-if="agentUrl" stacked :label="t(`sandbox.sandboxOverview.sandboxUrl`)">
                            <!-- `touch-target`: this link isn't exempt like inline prose text, since it's icon-bearing, alone on its row, and opens a new tab. -->
                            <a
                                :href="agentUrl"
                                target="_blank"
                                rel="noopener"
                                class="touch-target inline-flex min-w-0 items-start gap-1 py-1 font-mono text-link hover:underline"
                            >
                                <span class="min-w-0 [overflow-wrap:anywhere]">{{ agentUrl }}</span>
                                <Icon name="external-link" class="shrink-0 text-2xs" />
                            </a>
                            <template #action><CopyButton :text="agentUrl" /></template>
                        </OverviewSettingRow>
                    </dl>
                </section>
            </div>
        </Card>

        <!-- Recreates the container serving this page, so it warns before it is applied and the reconnect is the answer. -->
        <SandboxResourcesDialog
            v-if="canShip && selfResources.reshapable.value"
            :open="resizing"
            :name="sandbox.active.value?.name ?? selfResources.slug.value ?? ``"
            :current="selfResources.current.value"
            :engine="selfResources.engine.value"
            :self-warning="true"
            :can-save="selfResources.canSave.value"
            @cancel="resizing = false"
            @apply="applyResize"
            @save="saveResize"
        />

        <!-- What fills the disk and what may be freed; maintainer-only like the routes behind it, self-hides otherwise. -->
        <SandboxStorageCard />

        <!-- Upgrade path for hosted sandboxes only (a member can't create one for the owner). -->
        <Card v-if="hosted && isOwner" class="flex flex-col gap-2">
            <div class="flex items-center gap-2 text-sm font-medium text-content">
                <Icon name="bolt" class="text-link" /> {{ t(`sandbox.sandboxOverview.needMorePower`) }}
            </div>
            <!-- The cost fact is shown first: what a reader of this card usually comes here to check. -->
            <p v-if="machineStanding" class="text-xs text-muted">
                <span class="text-content">{{ machineStanding }}</span>
                <template v-if="planOffered">
                    ·
                    <RouterLink :to="here(page.account(`billing`))" class="text-link hover:underline">{{
                        t(`sandbox.sandboxOverview.billing`)
                    }}</RouterLink></template
                >
            </p>
            <p class="text-xs leading-relaxed text-muted">
                {{ starterMachine ? t(`sandbox.sandboxOverview.sandboxSmallStarterMachine`) : t(`sandbox.sandboxOverview.sandboxHostedMachine`) }}
                <span class="text-content">{{ t(`sandbox.sandboxOverview.ownDevice`) }}</span
                >{{ t(`sandbox.sandboxOverview.noHourLimitNothing`) }}
            </p>
            <RouterLink :to="ADD_SANDBOX_HOME_PATH" class="text-xs text-link hover:underline">{{ t(`sandbox.sandboxOverview.setUp`) }}</RouterLink>
        </Card>

        <!-- The files here exist nowhere else and the reader is at a computer that could change that; self-hides otherwise. -->
        <SandboxBackupCard />

        <!-- A newer sandbox image has shipped; this prompt self-hides otherwise. -->
        <SandboxUpdateCard />

        <!-- Names a route gap between this app and the daemon instead of a silent 404; fires in dev too, where versions are all 0.0.0. -->
        <SandboxBehindCard />
        <SandboxManifestCard />

        <!-- Last on the page, and only a press away from its question: the dialog asks, counts down and can be undone. -->
        <Card
            v-if="sandbox.active.value"
            data-setting="overview-remove"
            class="flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <h3 class="text-sm font-medium text-content">
                    {{ isOwner ? t(`sandbox.removeAsk.removeThis`) : t(`sandbox.removeAsk.leaveThis`) }}
                </h3>
                <p class="text-xs text-muted">{{ removeLead }}</p>
            </div>
            <div class="shrink-0">
                <Button size="small" tier="quiet" tone="danger" :label="isOwner ? t(`ui.action.remove`) : t(`ui.action.leave`)" @click="askRemove">
                    <template #icon><Icon :name="isOwner ? `trash` : `sign-out`" /></template>
                </Button>
            </div>
        </Card>
    </div>
</template>
