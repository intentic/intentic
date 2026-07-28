<script setup lang="ts">
import { Card, Row, RowGroup, StatusBadge } from "@intentic-app/ui";
import Button from "primevue/button";
import { computed, nextTick, ref } from "vue";
import { useChat } from "../../composables/chat/useChat";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { fileToSquareDataUrl } from "../../composables/imageDataUrl";
import { useRunning } from "../../composables/sandbox/useRunning";
import { useSandboxVersion } from "../../composables/sandbox/useSandboxVersion";
import { useMissingSecretCount } from "../../composables/secrets/useSecrets";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { errorMessage } from "../../composables/useAsyncAction";
import { presenceOthers } from "../../composables/usePresence";
import SandboxBehindCard from "./SandboxBehindCard.vue";
import SandboxUpdateCard from "./SandboxUpdateCard.vue";

/* The Sandbox hub's "Overview" tab — the calm landing. Sandbox identity (name + logo, inline-editable by the
 * owner, absorbing the old SandboxSettingsDialog), the self-reported image + version + URL, online status, the
 * non-blocking update prompt, and a compact "at a glance" block that deep-links to the other tabs. The platform
 * stores only the binding; the image/version/URL are relayed live via the daemon's /info. */

const sandbox = useSandbox();
const { info, installed, latest, updateAvailable } = useSandboxVersion();
const { claudeConnected } = useChat();
const { capabilities } = useCapabilities();
const { runningCount } = useRunning();
const { countPending, missingRequiredCount } = useMissingSecretCount();

const isOwner = computed(() => sandbox.active.value?.role === `owner`);
const agentUrl = computed(() => sandbox.daemonUrl.value ?? undefined);
const othersHere = computed(() => presenceOthers.value.length);

// Inline identity editing (owner only): rename + pick a logo. The picked file never uploads — it is downscaled
// to a small square data URL in the browser and stored as a string (sandbox.update). Only changed fields sent.
// Editing is strictly in place: every control it needs already occupies a slot in the header (the title box, the
// logo, the action cell), so entering edit mode reveals affordances without reflowing a single pixel below.
const editing = ref(false);
const name = ref(``);
const stagedImage = ref<string | undefined>(undefined);
const fileInput = ref<HTMLInputElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const nameTouched = ref(false);
const busy = ref(false);
const error = ref<string | undefined>(undefined);

const previewImage = computed(() => stagedImage.value ?? sandbox.active.value?.image ?? undefined);
const avatarLetter = computed(() => (editing.value ? name.value : (sandbox.active.value?.name ?? ``)).trim().charAt(0));
const nameError = computed<string | undefined>(() => {
    const trimmed = name.value.trim();
    if (trimmed.length === 0) return `Name is required.`;
    if (trimmed.length > 60) return `Name must be 60 characters or fewer.`;
    return undefined;
});
const canSave = computed(() => {
    const trimmed = name.value.trim();
    return trimmed.length > 0 && trimmed.length <= 60 && (trimmed !== sandbox.active.value?.name || stagedImage.value !== undefined);
});

// The single line under the title, present in every state so nothing can grow or shrink beneath it: the
// sandbox's status when idle, the edit affordances while editing, and errors in place of both.
const subline = computed<{ text: string; tone: string }>(() => {
    if (error.value !== undefined) return { text: error.value, tone: `text-danger` };
    if (editing.value && nameTouched.value && nameError.value !== undefined) return { text: nameError.value, tone: `text-danger` };
    if (editing.value) return { text: `Click the logo to change it (cropped to a square) · Enter saves · Esc cancels.`, tone: `text-muted` };
    if (sandbox.reachable.value) return { text: `Online — the workspace Claude Code and your tools operate from.`, tone: `text-muted` };
    return { text: `Offline — reconnecting to the workspace.`, tone: `text-muted` };
});

const startEdit = async (): Promise<void> => {
    name.value = sandbox.active.value?.name ?? ``;
    stagedImage.value = undefined;
    error.value = undefined;
    nameTouched.value = false;
    editing.value = true;
    await nextTick();
    nameInput.value?.select();
};
const cancelEdit = (): void => {
    editing.value = false;
    stagedImage.value = undefined;
    error.value = undefined;
};

const pickFile = async (event: Event): Promise<void> => {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = ``;
    if (file === undefined) {
        return;
    }
    error.value = undefined;
    try {
        stagedImage.value = await fileToSquareDataUrl(file);
    } catch {
        error.value = `Couldn't read that file as an image.`;
    }
};

const save = async (): Promise<void> => {
    const trimmed = name.value.trim();
    if (busy.value || !canSave.value) {
        return;
    }
    busy.value = true;
    error.value = undefined;
    try {
        await sandbox.update({
            ...(trimmed !== sandbox.active.value?.name && { name: trimmed }),
            ...(stagedImage.value !== undefined && { image: stagedImage.value }),
        });
        editing.value = false;
        stagedImage.value = undefined;
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
                    <!-- The logo IS the picker while editing — that's what removes the old "Choose image" row,
                         and with it the card's height change. Disabled outside edit mode, so it stays a plain
                         decorative avatar (and out of the tab order) until it can actually do something. -->
                    <button
                        type="button"
                        :disabled="!editing"
                        :aria-label="editing ? `Change logo` : undefined"
                        v-tooltip.bottom="editing ? `Change logo` : undefined"
                        class="group relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-card text-muted"
                        :class="editing ? 'cursor-pointer border-line-strong' : 'border-line'"
                        @click="fileInput?.click()"
                    >
                        <img v-if="previewImage" :src="previewImage" alt="" class="h-full w-full object-cover" />
                        <span v-else-if="avatarLetter" class="text-lg font-semibold uppercase text-content">{{ avatarLetter }}</span>
                        <Icon name="server" v-else class="text-lg" />
                        <span
                            v-if="editing"
                            class="absolute inset-0 flex items-center justify-center bg-canvas/70 text-content opacity-90 transition-opacity group-hover:opacity-100"
                        >
                            <Icon name="image" class="text-base" />
                        </span>
                    </button>
                    <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="pickFile" />

                    <!-- Title and field share one box — same height, padding and type scale — so switching modes
                         only paints a border; the glyphs never move. The subline below is always rendered. -->
                    <div class="-ml-2 min-w-0 flex-1 sm:max-w-md">
                        <div class="grid grid-cols-1 grid-rows-1">
                            <input
                                v-if="editing"
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
                            <h2
                                v-else
                                class="col-start-1 row-start-1 flex h-8 items-center rounded-md border border-transparent px-2 text-lg font-semibold"
                            >
                                <span class="truncate">{{ sandbox.active.value?.name ?? `Sandbox` }}</span>
                            </h2>
                        </div>
                        <p class="h-4 truncate px-2 text-xs leading-4" :class="subline.tone">{{ subline.text }}</p>
                    </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                    <StatusBadge
                        :variant="sandbox.reachable.value ? 'success' : 'neutral'"
                        :label="sandbox.reachable.value ? 'Online' : 'Offline'"
                        dot
                    />
                    <!-- Edit and Cancel/Save are stacked in one grid cell: the cell is as wide as the widest
                         state, so revealing Save can never shove the status badge sideways. The inactive layer
                         is `invisible`, which keeps its size while dropping out of the tab order and the a11y
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

        <!-- At a glance: compact deep-links into the detail tabs, so the landing stays calm. -->
        <RowGroup label="At a glance">
            <RouterLink to="/sandbox/agent" class="block">
                <Row
                    icon="sparkles"
                    title="Agent account"
                    description="The Claude account Claude Code runs as, stored in your sandbox."
                    interactive
                    chevron
                >
                    <template #control>
                        <StatusBadge
                            :variant="claudeConnected ? 'success' : 'warning'"
                            :label="claudeConnected ? 'Ready' : 'Needs authorization'"
                            size="xs"
                            dot
                        />
                    </template>
                </Row>
            </RouterLink>

            <RouterLink to="/sandbox/secrets" class="block">
                <Row icon="key" title="Secrets" description="Credentials and generated values stored inside this sandbox." interactive chevron>
                    <template #control>
                        <StatusBadge v-if="countPending" variant="neutral" label="Checking" size="xs" />
                        <StatusBadge
                            v-else-if="missingRequiredCount > 0"
                            variant="warning"
                            :label="`${missingRequiredCount} missing`"
                            size="xs"
                            dot
                        />
                        <StatusBadge v-else variant="success" label="Ready" size="xs" dot />
                    </template>
                </Row>
            </RouterLink>

            <RouterLink to="/capabilities" class="block">
                <Row icon="th-large" title="Capabilities" description="Tools, services and integrations this sandbox can use." interactive chevron>
                    <template #control
                        ><span class="text-2xs text-subtle">{{ capabilities.length }}</span></template
                    >
                </Row>
            </RouterLink>

            <RouterLink to="/sandbox/status" class="block">
                <Row icon="bolt" title="Running now" description="Live operator panels and active services." interactive chevron>
                    <template #control
                        ><span class="text-2xs text-subtle">{{ runningCount }}</span></template
                    >
                </Row>
            </RouterLink>

            <RouterLink to="/sandbox/access" class="block">
                <Row icon="users" title="Access" description="Who can reach this sandbox." interactive chevron>
                    <template #control>
                        <span v-if="othersHere > 0" class="text-2xs text-success">{{ othersHere }} here now</span>
                    </template>
                </Row>
            </RouterLink>
        </RowGroup>
    </div>
</template>
