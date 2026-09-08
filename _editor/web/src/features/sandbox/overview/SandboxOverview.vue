<script setup lang="ts">
import { AnchoredOverlay, Card, ui, StatusBadge, vAction } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, nextTick, ref } from "vue";
import { fileToSquareDataUrl } from "../../../lib/imageDataUrl";
import { useSandboxVersion } from "./useSandboxVersion";
import { useSandbox } from "../client/useSandbox";
import { useHostedPlan } from "../../settings/hosted-plan/useHostedPlan";
import { useSandboxOutline } from "./useSandboxOutline";
import { sandboxAvailabilityVisual } from "./availability";
import { useSandboxAvailability } from "./useSandboxAvailability";
import { useWorkspaceTree } from "../../workspace/explorer/useWorkspaceTree";
import SandboxBehindCard from "./SandboxBehindCard.vue";
import SandboxManifestCard from "./SandboxManifestCard.vue";
import SandboxUpdateCard from "./SandboxUpdateCard.vue";

// Overview tab: sandbox identity (name, logo), self-reported image/version/URL relayed live via /info, online
// status, and the non-blocking update prompt. Excludes per-tab status links or a running list: those duplicate
// badges and panels that already live elsewhere (rail, tab badges, Preview/Ports).

const sandbox = useSandbox();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityBadge = computed(() => sandboxAvailabilityVisual(availability.value));
const { info, installed, latest, updateAvailable, isLoading: infoLoading } = useSandboxVersion();
const outline = useSandboxOutline(infoLoading);

const isOwner = computed(() => sandbox.active.value?.role === `owner`);
const agentUrl = computed(() => sandbox.daemonUrl.value ?? undefined);
// Platform-hosted (starter) sandbox; the upgrade card below keys on this.
const hosted = computed(() => (sandbox.active.value?.hosted ?? null) !== null);
// Same standing sentence Billing and the avatar row use, kept in sync by sharing the source.
const { machineStanding, offered: planOffered } = useHostedPlan();

// Inline rename (owner only): controls sit beside the name so entering edit mode never changes the card's height.
// The logo is separate and live at all times; picking a file saves immediately (`pickFile`), no commit step needed.
const editing = ref(false);
const name = ref(``);
const fileInput = ref<HTMLInputElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const nameTouched = ref(false);
const busy = ref(false);
const error = ref<string | undefined>(undefined);

// Menu opens only over a tile that already has a logo (two choices to offer); an empty tile skips straight to the
// file dialog. Anchored rather than a Popover, so every menu in the app measures the same way.
const logoTrigger = ref<HTMLButtonElement | null>(null);
const logoMenuOpen = ref(false);
const logoBusy = ref(false);
const logo = computed(() => sandbox.active.value?.image ?? undefined);
const avatarLetter = computed(() => (editing.value ? name.value : (sandbox.active.value?.name ?? ``)).trim().charAt(0));
const nameError = computed<string | undefined>(() => {
    const trimmed = name.value.trim();
    if (trimmed.length === 0) {
        return `Name is required.`;
    }
    if (trimmed.length > 60) {
        return `Name must be 60 characters or fewer.`;
    }
    return undefined;
});
const canSave = computed(() => {
    const trimmed = name.value.trim();
    return trimmed.length > 0 && trimmed.length <= 60 && trimmed !== sandbox.active.value?.name;
});

// One line under the title for every state (idle status, rename hint, or an error from either control), so
// nothing shifts height.
const subline = computed<{ text: string; tone: string }>(() => {
    if (error.value !== undefined) {
        return { text: error.value, tone: `text-danger` };
    }
    if (editing.value && nameTouched.value && nameError.value !== undefined) {
        return { text: nameError.value, tone: `text-danger` };
    }
    if (editing.value) {
        return { text: `Enter saves · Esc cancels.`, tone: `text-muted` };
    }
    if (availability.value === `busy`) {
        return { text: `The sandbox is busy, live actions resume automatically.`, tone: `text-muted` };
    }
    if (availability.value === `starting` || availability.value === `warming`) {
        return { text: `Getting the workspace ready…`, tone: `text-muted` };
    }
    return { text: ``, tone: `text-muted` };
});

const startEdit = async (): Promise<void> => {
    name.value = sandbox.active.value?.name ?? ``;
    error.value = undefined;
    nameTouched.value = false;
    editing.value = true;
    await nextTick();
    nameInput.value?.select();
};
const cancelEdit = (): void => {
    editing.value = false;
    error.value = undefined;
};

// Offers replace/remove when there's a logo to act on; otherwise goes straight to the file dialog.
const pressLogo = (): void => {
    error.value = undefined;
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
    error.value = undefined;
    try {
        await sandbox.update(id, { image });
    } catch (err) {
        error.value = errorMessage(err, `Couldn't save the logo.`);
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
    error.value = undefined;
    // Contained, not cropped, since a centre slice of a wordmark loses it; a failed read is a file error, not a save
    // error.
    let square: string;
    try {
        square = await fileToSquareDataUrl(file, `contain`);
    } catch {
        error.value = `Couldn't read that file as an image.`;
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

const save = async (): Promise<void> => {
    const id = sandbox.active.value?.id;
    const trimmed = name.value.trim();
    if (id === undefined || busy.value || !canSave.value) {
        return;
    }
    busy.value = true;
    error.value = undefined;
    try {
        await sandbox.update(id, { name: trimmed });
        editing.value = false;
    } catch (err) {
        error.value = errorMessage(err, `Couldn't save sandbox settings.`);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div class="@container flex flex-col gap-6">
        <!-- Identity: name + logo (owner-editable), self-reported image/version/URL, online status. -->
        <Card class="flex flex-col gap-4">
            <div class="flex flex-col gap-3 @2xl:flex-row @2xl:items-center @2xl:justify-between">
                <div class="flex min-w-0 flex-1 items-center gap-3">
                    <!--
                        The logo tile is the control itself: live for owners in every state, disabled for members. The hover/focus/busy
                        overlay is one layer, so the tile's size never changes.
                    -->
                    <button
                        ref="logoTrigger"
                        type="button"
                        :disabled="!isOwner || logoBusy"
                        :aria-label="isOwner ? (logo ? `Change or remove the logo` : `Add a logo`) : undefined"
                        v-tooltip.bottom="isOwner ? (logo ? `Change or remove the logo` : `Add a logo`) : undefined"
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
                                <Icon name="image" class="shrink-0 text-sm text-muted" />Change logo…
                            </button>
                            <button
                                type="button"
                                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-danger transition-colors hover:bg-danger/10"
                                v-action="removeLogo"
                            >
                                <Icon name="trash" class="shrink-0 text-sm" />Remove logo
                            </button>
                        </div>
                    </AnchoredOverlay>

                    <div class="-ml-2 min-w-0 flex-1 @2xl:max-w-md">
                        <div class="flex items-center gap-2">
                            <div class="flex min-w-0 items-center">
                                <!--
                                    Title and field share one box (height, padding, type scale) so switching modes only paints a border. The hidden
                                    sizer keeps the field width proportional to its text.
                                -->
                                <div class="grid w-fit min-w-0 max-w-full grid-cols-1 grid-rows-1">
                                    <template v-if="editing">
                                        <span
                                            aria-hidden="true"
                                            class="invisible col-start-1 row-start-1 flex h-8 min-w-0 items-center truncate rounded-md border border-transparent px-2 text-lg font-semibold"
                                            >{{ name === `` ? ` ` : name }}</span
                                        >
                                        <input
                                            ref="nameInput"
                                            v-model="name"
                                            type="text"
                                            aria-label="Sandbox name"
                                            autocomplete="off"
                                            maxlength="60"
                                            class="ui-field-box col-start-1 row-start-1 h-8 w-full min-w-0 px-2 text-lg font-semibold"
                                            :class="nameTouched && nameError ? 'ui-field-error-box' : ''"
                                            @blur="nameTouched = true"
                                            @keydown.enter.prevent="save"
                                            @keydown.esc.prevent="cancelEdit"
                                        />
                                    </template>
                                    <h2
                                        v-else
                                        class="col-start-1 row-start-1 flex h-8 items-center rounded-md border border-transparent px-2 text-lg font-semibold"
                                    >
                                        <span class="truncate">{{ sandbox.active.value?.name ?? `Sandbox` }}</span>
                                    </h2>
                                </div>

                                <!-- Rename controls sit beside the name: a pencil at rest, compact check/cancel icons while editing. -->
                                <div v-if="isOwner" class="flex shrink-0 items-center gap-1">
                                    <template v-if="editing">
                                        <button
                                            type="button"
                                            :class="ui.iconButton(`h-8 w-8 text-subtle hover:text-success`)"
                                            :disabled="busy || !canSave"
                                            aria-label="Save sandbox name"
                                            v-tooltip.bottom="`Save · Enter`"
                                            v-action="save"
                                        >
                                            <Icon :name="busy ? `spinner` : `check`" :spin="busy" />
                                        </button>
                                        <button
                                            type="button"
                                            :class="ui.iconButton(`h-8 w-8 text-subtle`)"
                                            :disabled="busy"
                                            aria-label="Cancel rename"
                                            v-tooltip.bottom="`Cancel · Esc`"
                                            @click="cancelEdit"
                                        >
                                            <Icon name="times" />
                                        </button>
                                    </template>
                                    <button
                                        v-else
                                        type="button"
                                        :class="ui.iconButton(`h-8 w-8 text-subtle`)"
                                        aria-label="Rename sandbox"
                                        v-tooltip.bottom="`Rename sandbox`"
                                        v-action="startEdit"
                                    >
                                        <Icon name="pencil" class="text-xs" />
                                    </button>
                                </div>
                            </div>
                            <StatusBadge class="shrink-0" :variant="availabilityBadge.variant" :label="availabilityBadge.label" dot />
                        </div>
                        <p v-if="subline.text" class="h-4 truncate px-2 text-xs leading-4" :class="subline.tone">{{ subline.text }}</p>
                    </div>
                </div>
            </div>

            <!--
                Reserves this card's second half while /info is still loading, since identity above renders instantly from the
                platform; without it the card would grow and shift content once info arrives.
            -->
            <div
                v-if="sandbox.reachable.value && infoLoading && outline"
                role="status"
                aria-busy="true"
                class="flex flex-col gap-2 rounded-lg bg-canvas px-3 py-2.5"
            >
                <span class="sr-only">Reading what this sandbox reports about itself…</span>
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
                    <dt class="text-subtle">Image</dt>
                    <dd class="min-w-0 text-right">
                        <div class="truncate font-mono text-content">{{ info.image }}</div>
                        <div v-if="installed" class="mt-0.5 font-mono text-subtle">
                            installed version {{ installed }}
                            <span v-if="updateAvailable" class="text-warning">→ {{ latest }} available</span>
                        </div>
                    </dd>
                </div>
                <div v-else-if="installed" class="flex items-center justify-between gap-3">
                    <dt class="text-subtle">Installed version</dt>
                    <dd class="font-mono text-content">
                        {{ installed }}
                        <span v-if="updateAvailable" class="text-warning">→ {{ latest }} available</span>
                    </dd>
                </div>
                <div v-if="agentUrl" class="flex items-center justify-between gap-3">
                    <dt class="text-subtle">Sandbox URL</dt>
                    <dd class="min-w-0">
                        <!--
                            `touch-target`: this link isn't exempt like inline prose text, since it's icon-bearing, alone on its row, and
                            opens a new tab.
                        -->
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

        <!--
            Upgrade path for hosted sandboxes only (a member can't create one for the owner). One upgrade offered: the
            reader's own device, since it's free hardware they already have.
        -->
        <Card v-if="hosted && isOwner" class="flex flex-col gap-2">
            <div class="flex items-center gap-2 text-sm font-medium text-content"><Icon name="bolt" class="text-link" /> Need more power?</div>
            <!-- The cost fact is shown first: what a reader of this card usually comes here to check. -->
            <p v-if="machineStanding" class="text-xs text-muted">
                <span class="text-content">{{ machineStanding }}</span>
                <template v-if="planOffered"> · <RouterLink to="/settings/billing" class="text-link hover:underline">Billing</RouterLink></template>
            </p>
            <p class="text-xs leading-relaxed text-muted">
                This sandbox is a small starter machine we host for you. When it feels tight, move it to
                <span class="text-content">your own device</span>: no hour limit, nothing metered, and the only place your GPU is.
            </p>
            <RouterLink to="/setup" class="text-xs text-link hover:underline">Set it up there →</RouterLink>
        </Card>

        <!-- A newer sandbox image has shipped; this prompt self-hides otherwise. -->
        <SandboxUpdateCard />

        <!--
            Names a route gap between this app and the daemon instead of a silent 404; fires in dev too, where versions are
            all 0.0.0. Self-hides.
        -->
        <SandboxBehindCard />
        <SandboxManifestCard />
    </div>
</template>
