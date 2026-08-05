<script setup lang="ts">
import { Card, StatusBadge } from "@intentic/ui";
import Button from "primevue/button";
import Popover from "primevue/popover";
import { computed, nextTick, ref } from "vue";
import { fileToSquareDataUrl } from "../../composables/imageDataUrl";
import { useSandboxVersion } from "../../composables/sandbox/useSandboxVersion";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { errorMessage } from "../../composables/useAsyncAction";
import SandboxBehindCard from "./SandboxBehindCard.vue";
import SandboxUpdateCard from "./SandboxUpdateCard.vue";

/* The Sandbox hub's "Overview" tab — WHAT THIS BOX IS. Sandbox identity (the name, inline-editable by the
 * owner, and the logo, which is a control in its own right), the self-reported image + version + URL, online
 * status, and the non-blocking update prompt. The platform stores only the binding; the image/version/URL are
 * relayed live via the daemon's /info.
 *
 * IT DOES NOT INDEX THE OTHER TABS. It used to end in an "at a glance" block: five rows deep-linking to Agent,
 * Secrets, Capabilities, Status and Access, each with a status chip. Every one of those was a second way to say
 * something already on screen — four of the five pointed at tabs in the strip directly above them (and named
 * them differently: "Running now" for Status), the Status tab already wore the same running count as a pill
 * badge, presence is in the rail, and missing secrets badge the sandbox chip. The fifth left the hub entirely,
 * for a page the rail's "+" opens. What was left on a healthy sandbox read "Ready · Ready · 4 · 0 · —": five
 * rows and a chevron
 * each to report that nothing needs doing, which is the exact pattern this app rejects everywhere else (the
 * rail's VPN indicator, the Extensions tab's silent nominal case). The one condition it carried that had no
 * other home — nothing connected to run a turn with — is an attention item now (sandboxAttention), so it rides
 * the chip badge with the other four instead of a row that says "Ready" for the rest of the sandbox's life. */

const sandbox = useSandbox();
const { info, installed, latest, updateAvailable } = useSandboxVersion();

const isOwner = computed(() => sandbox.active.value?.role === `owner`);
const agentUrl = computed(() => sandbox.daemonUrl.value ?? undefined);

// Inline renaming (owner only), strictly in place: the title box and the action cell already occupy their slots
// in the header, so entering edit mode reveals affordances without reflowing a single pixel below.
//
// THE LOGO IS NOT PART OF THIS FORM, and that is the correction. It used to be reachable only from inside
// name-edit mode — press Edit, then discover that the decorative-looking tile had become a file picker — so the
// one question a fresh sandbox actually prompts ("that's a letter, where do I put my logo?") had its answer
// hidden behind a control that says "rename". A logo is one click and one file, with nothing to validate and
// nothing to type, so it needs no commit step of its own: the tile is live for owners at all times, picking
// saves immediately (see `pickFile`), and the rail chip repaints in the same tick from the same cache write.
const editing = ref(false);
const name = ref(``);
const fileInput = ref<HTMLInputElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const nameTouched = ref(false);
const busy = ref(false);
const error = ref<string | undefined>(undefined);

// The menu opens only over a tile that already HAS a logo, because only then are there two answers (replace,
// remove) to choose between. An empty tile has exactly one thing to do, and a menu with a single row is a click
// charged for nothing — so it opens the file dialog directly.
const logoMenu = ref<InstanceType<typeof Popover> | null>(null);
const logoBusy = ref(false);
const logo = computed(() => sandbox.active.value?.image ?? undefined);
const avatarLetter = computed(() => (editing.value ? name.value : (sandbox.active.value?.name ?? ``)).trim().charAt(0));
const nameError = computed<string | undefined>(() => {
    const trimmed = name.value.trim();
    if (trimmed.length === 0) return `Name is required.`;
    if (trimmed.length > 60) return `Name must be 60 characters or fewer.`;
    return undefined;
});
const canSave = computed(() => {
    const trimmed = name.value.trim();
    return trimmed.length > 0 && trimmed.length <= 60 && trimmed !== sandbox.active.value?.name;
});

// The single line under the title, present in every state so nothing can grow or shrink beneath it: the
// sandbox's status when idle, the rename hint while editing, and errors — from either control — in place of both.
const subline = computed<{ text: string; tone: string }>(() => {
    if (error.value !== undefined) return { text: error.value, tone: `text-danger` };
    if (editing.value && nameTouched.value && nameError.value !== undefined) return { text: nameError.value, tone: `text-danger` };
    if (editing.value) return { text: `Enter saves · Esc cancels.`, tone: `text-muted` };
    if (sandbox.reachable.value) return { text: `The workspace Claude Code and your tools operate from.`, tone: `text-muted` };
    return { text: `Reconnecting to the workspace…`, tone: `text-muted` };
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

// The tile's press: choose between replace and remove when there is something to remove, otherwise go straight
// to the file dialog. Members never get here — the tile is disabled for them.
const pressLogo = (event: MouseEvent): void => {
    error.value = undefined;
    if (logo.value === undefined) {
        fileInput.value?.click();
        return;
    }
    logoMenu.value?.toggle(event);
};

// Write a logo straight through; `null` clears it. sandbox.update's cache write is what makes this tile and the
// rail chip change together, so there is nothing staged here to preview and nothing to reconcile afterwards.
const writeLogo = async (image: string | null): Promise<void> => {
    logoBusy.value = true;
    error.value = undefined;
    try {
        await sandbox.update({ image });
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
    // Contained rather than cropped: a sandbox logo is usually a mark or a wordmark, and a centre slice of a
    // wordmark is not the wordmark. A failure here is the FILE, not the save, so it says so.
    let square: string;
    try {
        square = await fileToSquareDataUrl(file, `contain`);
    } catch {
        error.value = `Couldn't read that file as an image.`;
        return;
    }
    await writeLogo(square);
};

// Both menu rows dismiss it themselves: the file dialog is a separate window and the removal is instant, so a
// menu still hanging over the tile afterwards would be the only thing left to tidy up by hand.
const changeLogo = (): void => {
    logoMenu.value?.hide();
    fileInput.value?.click();
};

const removeLogo = async (): Promise<void> => {
    logoMenu.value?.hide();
    await writeLogo(null);
};

const save = async (): Promise<void> => {
    const trimmed = name.value.trim();
    if (busy.value || !canSave.value) {
        return;
    }
    busy.value = true;
    error.value = undefined;
    try {
        await sandbox.update({ name: trimmed });
        editing.value = false;
    } catch (err) {
        error.value = errorMessage(err, `Couldn't save sandbox settings.`);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Identity: name + logo (owner-editable), self-reported image / version / URL, online status. -->
        <Card class="flex flex-col gap-4">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div class="flex min-w-0 flex-1 items-center gap-3">
                    <!-- The logo IS the control — no "Choose image" row to add, so the card never changes height.
                         Live for owners in every state (a logo has nothing to commit), disabled and out of the
                         tab order for members, who cannot change it. The overlay is the affordance: it rests at
                         zero opacity so the tile reads as identity, and appears on hover, on keyboard focus and
                         for the whole save — the same layer, so the tile's size is fixed in all three. -->
                    <button
                        type="button"
                        :disabled="!isOwner || logoBusy"
                        :aria-label="isOwner ? (logo ? `Change or remove the logo` : `Add a logo`) : undefined"
                        v-tooltip.bottom="isOwner ? (logo ? `Change or remove the logo` : `Add a logo`) : undefined"
                        class="group relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-card text-muted"
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

                    <!-- Only ever opened over a tile that HAS a logo, so both rows always do something. -->
                    <Popover ref="logoMenu" append-to="body">
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
                                @click="removeLogo"
                            >
                                <Icon name="trash" class="shrink-0 text-sm" />Remove logo
                            </button>
                        </div>
                    </Popover>

                    <div class="-ml-2 min-w-0 flex-1 sm:max-w-md">
                        <div class="flex items-center gap-2">
                            <!-- Title and field share one box — same height, padding and type scale — so switching
                                 modes only paints a border; the glyphs never move. In edit mode a hidden sizer
                                 span mirrors the name in the same cell, so the input is as wide as the text it
                                 holds instead of claiming the whole row. -->
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
                                        class="col-start-1 row-start-1 h-8 w-full min-w-0 rounded-md border border-line-strong bg-canvas px-2 text-lg font-semibold text-content outline-none"
                                        :class="nameTouched && nameError ? 'ui-field-input-error' : ''"
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
                            <StatusBadge
                                class="shrink-0"
                                :variant="sandbox.reachable.value ? 'success' : 'neutral'"
                                :label="sandbox.reachable.value ? 'Online' : 'Offline'"
                                dot
                            />
                        </div>
                        <p class="h-4 truncate px-2 text-xs leading-4" :class="subline.tone">{{ subline.text }}</p>
                    </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                    <!-- Edit and Cancel/Save are stacked in one grid cell: the cell is as wide as the widest
                         state, so revealing Save can never reflow the header. The inactive layer is
                         `invisible`, which keeps its size while dropping out of the tab order and the a11y
                         tree. Save sits where Edit sat — the same corner keeps meaning "commit". -->
                    <div v-if="isOwner" class="grid grid-cols-1 grid-rows-1 items-center">
                        <div class="col-start-1 row-start-1 flex items-center justify-end" :class="editing ? 'invisible' : ''">
                            <Button label="Edit" size="small" severity="secondary" :text="true" @click="startEdit">
                                <template #icon><Icon name="pencil" /></template>
                            </Button>
                        </div>
                        <div class="col-start-1 row-start-1 flex items-center justify-end gap-2" :class="editing ? '' : 'invisible'">
                            <Button label="Cancel" size="small" severity="secondary" :text="true" :disabled="busy" @click="cancelEdit" />
                            <Button label="Save" size="small" class="min-w-[5.5rem]" :loading="busy" :disabled="busy || !canSave" @click="save" />
                        </div>
                    </div>
                </div>
            </div>

            <!-- What the sandbox reports about itself (relayed via /info, never stored by the platform). -->
            <dl
                v-if="sandbox.reachable.value && (info?.image || installed || agentUrl)"
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
                        <a
                            :href="agentUrl"
                            target="_blank"
                            rel="noopener"
                            class="inline-flex items-center gap-1 truncate font-mono text-link hover:underline"
                        >
                            {{ agentUrl }}<Icon name="external-link" class="text-2xs" />
                        </a>
                    </dd>
                </div>
            </dl>
        </Card>

        <!-- A newer sandbox image has shipped: the non-blocking, host-run update prompt (self-hides otherwise). -->
        <SandboxUpdateCard />

        <!-- This daemon predates routes the app knows: names the gap instead of letting them 404 unexplained.
             Version-independent, so it also fires in local dev where every package is 0.0.0. Self-hides. -->
        <SandboxBehindCard />
    </div>
</template>
