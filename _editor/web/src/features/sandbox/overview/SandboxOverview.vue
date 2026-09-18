<script setup lang="ts">
import { AnchoredOverlay, Card, InlineRename, StatusBadge, vAction } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { fileToSquareDataUrl } from "../../../lib/imageDataUrl";
import { useSandboxVersion } from "./useSandboxVersion";
import { useSandbox } from "../client/useSandbox";
import { useHostedPlan } from "../../settings/hosted-plan/useHostedPlan";
import { useSandboxOutline } from "./useSandboxOutline";
import { sandboxAvailabilityVisual } from "./availability";
import { useSandboxAvailability } from "./useSandboxAvailability";
import { useWorkspaceTree } from "../../workspace/explorer/useWorkspaceTree";
import SandboxBehindCard from "./SandboxBehindCard.vue";
import SandboxManifestCard from "./manifest/SandboxManifestCard.vue";
import SandboxUpdateCard from "./SandboxUpdateCard.vue";
import { useT } from "@intentic/ui/i18n";

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
const { info, installed, latest, updateAvailable, isLoading: infoLoading } = useSandboxVersion();
const outline = useSandboxOutline(infoLoading);

const isOwner = computed(() => sandbox.active.value?.role === `owner`);
const agentUrl = computed(() => sandbox.daemonUrl.value ?? undefined);
// Platform-hosted (starter) sandbox; the upgrade card below keys on this.
const hosted = computed(() => (sandbox.active.value?.hosted ?? null) !== null);
// Same standing sentence Billing and the avatar row use, kept in sync by sharing the source.
const { machineStanding, offered: planOffered } = useHostedPlan();

// The name renames itself in place (<InlineRename>, owner only). The logo is separate and live at all times;
// picking a file saves immediately (`pickFile`), no commit step needed.
const fileInput = ref<HTMLInputElement | null>(null);
const logoError = ref<string | undefined>(undefined);

// Menu opens only over a tile that already has a logo (two choices to offer); an empty tile skips straight to the
// file dialog. Anchored rather than a Popover, so every menu in the app measures the same way.
const logoTrigger = ref<HTMLButtonElement | null>(null);
const logoMenuOpen = ref(false);
const logoBusy = ref(false);
const logo = computed(() => sandbox.active.value?.image ?? undefined);
const avatarLetter = computed(() => (sandbox.active.value?.name ?? ``).trim().charAt(0));

// One line under the title, for the logo's own report and the sandbox's standing. The rename says nothing here:
// it carries its own state inside its own box, so entering and leaving edit mode cannot move this card.
const subline = computed<{ text: string; tone: string }>(() => {
    if (logoError.value !== undefined) {
        return { text: logoError.value, tone: `text-danger` };
    }
    if (availability.value === `busy`) {
        return { text: `The sandbox is busy, live actions resume automatically.`, tone: `text-muted` };
    }
    if (availability.value === `starting` || availability.value === `warming`) {
        return { text: `Getting the workspace ready…`, tone: `text-muted` };
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

// Offers replace/remove when there's a logo to act on; otherwise goes straight to the file dialog.
const pressLogo = (): void => {
    logoError.value = undefined;
    if (logo.value === undefined) {
        fileInput.value?.click();
        return;
    }
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
        logoError.value = errorMessage(err, `Couldn't save the logo.`);
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
    // Contained, not cropped, since a centre slice of a wordmark loses it; a failed read is a file error, not a save
    // error.
    let square: string;
    try {
        square = await fileToSquareDataUrl(file, `contain`);
    } catch {
        logoError.value = `Couldn't read that file as an image.`;
        return;
    }
    await writeLogo(square);
};

// Both menu rows close it themselves; nothing is left open to dismiss by hand afterward.
const changeLogo = (): void => {
    logoMenuOpen.value = false;
    fileInput.value?.click();
};

const removeLogo = async (): Promise<void> => {
    logoMenuOpen.value = false;
    await writeLogo(null);
};
</script>

<template>
    <div class="@container flex flex-col gap-6">
        <!-- Identity: name + logo (owner-editable), self-reported image/version/URL. -->
        <Card class="flex flex-col gap-4">
            <div class="flex flex-col gap-3 @2xl:flex-row @2xl:items-center @2xl:justify-between">
                <div class="flex min-w-0 flex-1 items-center gap-3">
                    <!-- The logo tile is the control itself: live for owners in every state, disabled for members. -->
                    <button
                        ref="logoTrigger"
                        type="button"
                        :disabled="!isOwner || logoBusy"
                        :aria-label="
                            isOwner ? (logo ? t(`sandbox.sandboxOverview.changeRemoveLogo`) : t(`sandbox.sandboxOverview.addLogo`)) : undefined
                        "
                        v-tooltip.bottom="
                            isOwner ? (logo ? t(`sandbox.sandboxOverview.changeRemoveLogo`) : t(`sandbox.sandboxOverview.addLogo`)) : undefined
                        "
                        class="group relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line-subtle bg-card text-muted"
                        :class="isOwner ? 'cursor-pointer hover:border-line-strong' : ''"
                        @click="pressLogo"
                    >
                        <img v-if="logo" :src="logo" alt="" class="h-full w-full object-cover" />
                        <span v-else-if="avatarLetter" class="text-lg font-semibold uppercase text-content">{{ avatarLetter }}</span>
                        <Icon name="server" v-else class="text-lg" />
                        <span
                            v-if="isOwner"
                            class="absolute inset-0 flex items-center justify-center bg-canvas/70 text-content transition-opacity"
                            :class="logoBusy ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'"
                        >
                            <Icon :name="logoBusy ? `spinner` : `image`" :spin="logoBusy" class="text-base" />
                        </span>
                    </button>
                    <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="pickFile" />

                    <!-- Only opened over a tile that already has a logo, so both menu rows always do something. -->
                    <AnchoredOverlay v-model="logoMenuOpen" :anchor="logoTrigger ?? undefined" side="bottom" cross="start">
                        <div class="flex w-44 flex-col gap-0.5">
                            <button
                                type="button"
                                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-content transition-colors hover:bg-content/5"
                                @click="changeLogo"
                            >
                                <Icon name="image" class="shrink-0 text-sm text-muted" />{{ t(`sandbox.sandboxOverview.changeLogo`) }}
                            </button>
                            <button
                                type="button"
                                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-danger transition-colors hover:bg-danger/10"
                                v-action="removeLogo"
                            >
                                <Icon name="trash" class="shrink-0 text-sm" />{{ t(`sandbox.sandboxOverview.removeLogo`) }}
                            </button>
                        </div>
                    </AnchoredOverlay>

                    <div class="-ml-1 min-w-0 flex-1 @2xl:max-w-md">
                        <div class="flex items-center gap-2">
                            <!-- The card's heading IS the rename: text at rest, a field in the same box, nothing added beside it.
                                 It stays an <h2> around that, so renaming the sandbox doesn't cost the card its heading. -->
                            <h2 class="flex min-w-0 text-lg font-semibold">
                                <InlineRename
                                    :value="sandbox.active.value?.name"
                                    :write="writeName"
                                    :label="t(`sandbox.sandboxOverview.sandboxName`)"
                                    :action="t(`sandbox.sandboxOverview.renameSandbox`)"
                                    fallback="Sandbox"
                                    :editable="isOwner"
                                    :maxlength="60"
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
                        </div>
                        <p v-if="subline.text" class="h-4 truncate px-1 text-xs leading-4" :class="subline.tone">{{ subline.text }}</p>
                    </div>
                </div>
            </div>

            <!-- Reserves this card's second half while /info is still loading, since identity above renders instantly from the platform. -->
            <div
                v-if="sandbox.reachable.value && infoLoading && outline"
                role="status"
                aria-busy="true"
                class="flex flex-col gap-2 rounded-lg bg-canvas px-3 py-2.5"
            >
                <span class="sr-only">{{ t(`sandbox.sandboxOverview.readingWhatSandboxReports`) }}</span>
                <div v-for="row in 2" :key="row" class="flex items-center justify-between gap-3" aria-hidden="true">
                    <span class="skeleton block h-2 w-16" />
                    <span class="skeleton block h-2" :class="row === 1 ? `w-48` : `w-32`" />
                </div>
            </div>

            <!-- What the sandbox reports about itself, relayed via /info and never stored by the platform. -->
            <dl
                v-else-if="sandbox.reachable.value && (info?.image || installed || agentUrl)"
                class="flex flex-col gap-1.5 rounded-lg bg-canvas px-3 py-2.5 text-2xs"
            >
                <div v-if="info?.image" class="flex items-start justify-between gap-3">
                    <dt class="text-subtle">{{ t(`sandbox.sandboxOverview.image`) }}</dt>
                    <dd class="min-w-0 text-right">
                        <div class="truncate font-mono text-content">{{ info.image }}</div>
                        <div v-if="installed" class="mt-0.5 font-mono text-subtle">
                            {{ t(`sandbox.sandboxOverview.installedVersion`) }} {{ installed }}
                            <span v-if="updateAvailable" class="text-warning">{{ t(`sandbox.sandboxOverview.available`, { latest }) }}</span>
                        </div>
                    </dd>
                </div>
                <div v-else-if="installed" class="flex items-center justify-between gap-3">
                    <dt class="text-subtle">{{ t(`sandbox.sandboxOverview.installedVersion2`) }}</dt>
                    <dd class="font-mono text-content">
                        {{ installed }}
                        <span v-if="updateAvailable" class="text-warning">{{ t(`sandbox.sandboxOverview.available`, { latest }) }}</span>
                    </dd>
                </div>
                <div v-if="agentUrl" class="flex items-center justify-between gap-3">
                    <dt class="text-subtle">{{ t(`sandbox.sandboxOverview.sandboxUrl`) }}</dt>
                    <dd class="min-w-0">
                        <!-- `touch-target`: this link isn't exempt like inline prose text, since it's icon-bearing, alone on its row, and opens a new tab. -->
                        <a
                            :href="agentUrl"
                            target="_blank"
                            rel="noopener"
                            class="touch-target inline-flex items-center gap-1 truncate font-mono text-link hover:underline"
                        >
                            {{ agentUrl }}<Icon name="external-link" class="text-2xs" />
                        </a>
                    </dd>
                </div>
            </dl>
        </Card>

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
                    <RouterLink to="/settings/billing" class="text-link hover:underline">{{
                        t(`sandbox.sandboxOverview.billing`)
                    }}</RouterLink></template
                >
            </p>
            <p class="text-xs leading-relaxed text-muted">
                {{ t(`sandbox.sandboxOverview.sandboxSmallStarterMachine`) }}
                <span class="text-content">{{ t(`sandbox.sandboxOverview.ownDevice`) }}</span
                >{{ t(`sandbox.sandboxOverview.noHourLimitNothing`) }}
            </p>
            <RouterLink to="/setup" class="text-xs text-link hover:underline">{{ t(`sandbox.sandboxOverview.setUp`) }}</RouterLink>
        </Card>

        <!-- A newer sandbox image has shipped; this prompt self-hides otherwise. -->
        <SandboxUpdateCard />

        <!-- Names a route gap between this app and the daemon instead of a silent 404; fires in dev too, where versions are all 0.0.0. -->
        <SandboxBehindCard />
        <SandboxManifestCard />
    </div>
</template>
