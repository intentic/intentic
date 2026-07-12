<script setup lang="ts">
import { Card, cmp, StatusBadge } from "@intentic-app/ui";
import Button from "primevue/button";
import { computed, ref } from "vue";
import { useChat } from "../../composables/chat/useChat";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { fileToSquareDataUrl } from "../../composables/imageDataUrl";
import { useRunning } from "../../composables/sandbox/useRunning";
import { useSandboxVersion } from "../../composables/sandbox/useSandboxVersion";
import { useSandbox } from "../../composables/useSandbox";
import { presenceOthers } from "../../composables/usePresence";
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

const isOwner = computed(() => sandbox.active.value?.role === `owner`);
const agentUrl = computed(() => sandbox.daemonUrl.value ?? undefined);
const othersHere = computed(() => presenceOthers.value.length);

// Inline identity editing (owner only): rename + pick a logo. The picked file never uploads — it is downscaled
// to a small square data URL in the browser and stored as a string (sandbox.update). Only changed fields sent.
const editing = ref(false);
const name = ref(``);
const stagedImage = ref<string | undefined>(undefined);
const fileInput = ref<HTMLInputElement | null>(null);
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

const startEdit = (): void => {
    name.value = sandbox.active.value?.name ?? ``;
    stagedImage.value = undefined;
    error.value = undefined;
    nameTouched.value = false;
    editing.value = true;
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
        error.value = err instanceof Error ? err.message : `Couldn't save sandbox settings.`;
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <!-- Identity: name + logo (owner-editable), self-reported image / version / URL, online status. -->
        <Card class="flex flex-col gap-4">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div class="flex min-w-0 items-center gap-3">
                    <span
                        class="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-card text-muted"
                    >
                        <img v-if="previewImage" :src="previewImage" alt="" class="h-full w-full object-cover" />
                        <span v-else-if="avatarLetter" class="text-lg font-semibold uppercase text-content">{{ avatarLetter }}</span>
                        <Icon name="server" v-else class="text-lg" />
                    </span>
                    <div class="min-w-0">
                        <label v-if="editing" class="flex flex-col gap-1">
                            <input
                                v-model="name"
                                type="text"
                                autocomplete="off"
                                maxlength="60"
                                :class="[cmp.input('w-full'), nameTouched && nameError ? 'ui-field-input-error' : '']"
                                @blur="nameTouched = true"
                            />
                            <span v-if="nameTouched && nameError" class="ui-field-error">
                                <Icon name="exclamation-triangle" class="text-2xs" />
                                {{ nameError }}
                            </span>
                        </label>
                        <h2 v-else class="truncate text-lg font-semibold leading-tight">{{ sandbox.active.value?.name ?? `Sandbox` }}</h2>
                        <p class="mt-0.5 text-xs text-muted">
                            <template v-if="sandbox.reachable.value">Online — the workspace Claude Code and your tools operate from.</template>
                            <template v-else>Offline — reconnecting to the workspace.</template>
                        </p>
                    </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                    <StatusBadge
                        :variant="sandbox.reachable.value ? 'success' : 'neutral'"
                        :label="sandbox.reachable.value ? 'Online' : 'Offline'"
                        dot
                    />
                    <Button v-if="isOwner && !editing" label="Edit" size="small" severity="secondary" :text="true" @click="startEdit">
                        <template #icon><Icon name="pencil" /></template>
                    </Button>
                </div>
            </div>

            <!-- Owner edit controls (logo + save/cancel); the name input lives in the header above. -->
            <div v-if="editing" class="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                <Button label="Choose image" severity="secondary" :outlined="true" size="small" @click="fileInput?.click()">
                    <template #icon><Icon name="image" /></template>
                </Button>
                <span class="text-2xs text-subtle">Cropped to a square and shown in the sandbox switcher.</span>
                <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="pickFile" />
                <div class="ml-auto flex items-center gap-2">
                    <Button label="Cancel" size="small" severity="secondary" :text="true" :disabled="busy" @click="cancelEdit" />
                    <Button label="Save" size="small" :loading="busy" :disabled="busy || !canSave" @click="save" />
                </div>
            </div>
            <p v-if="error" class="text-2xs text-danger">{{ error }}</p>

            <!-- What the sandbox reports about itself (relayed via /info, never stored by the platform). -->
            <dl
                v-if="sandbox.reachable.value && (info?.image || installed || agentUrl)"
                class="flex flex-col gap-1.5 rounded-lg border border-line bg-overlay/40 px-3 py-2.5 text-2xs"
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

        <!-- At a glance: compact deep-links into the detail tabs, so the landing stays calm. -->
        <Card class="flex flex-col gap-2">
            <div class="flex items-center gap-2.5">
                <Icon name="list-check" class="text-lg text-muted" />
                <div>
                    <h2 class="font-semibold leading-tight">At a glance</h2>
                    <p class="text-xs text-muted">Jump to the details for this sandbox.</p>
                </div>
            </div>

            <RouterLink
                to="/sandbox/agent"
                class="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2 transition-colors hover:border-line-strong hover:bg-overlay"
            >
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="sparkles" class="text-lg text-link" />
                    <div class="min-w-0">
                        <div class="font-medium text-content">Agent account</div>
                        <div class="text-xs text-muted">The Claude account Claude Code runs as, stored in your sandbox.</div>
                    </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                    <StatusBadge
                        :variant="claudeConnected ? 'success' : 'warning'"
                        :label="claudeConnected ? 'Ready' : 'Needs authorization'"
                        size="xs"
                        dot
                    />
                    <Icon name="chevron-right" class="text-2xs text-subtle" />
                </div>
            </RouterLink>

            <RouterLink
                to="/capabilities"
                class="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2 transition-colors hover:border-line-strong hover:bg-overlay"
            >
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="th-large" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <div class="font-medium text-content">Capabilities</div>
                        <div class="text-xs text-muted">Tools, services and integrations this sandbox can use.</div>
                    </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                    <span class="text-2xs text-subtle">{{ capabilities.length }}</span>
                    <Icon name="chevron-right" class="text-2xs text-subtle" />
                </div>
            </RouterLink>

            <RouterLink
                to="/sandbox/status"
                class="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2 transition-colors hover:border-line-strong hover:bg-overlay"
            >
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="bolt" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <div class="font-medium text-content">Running now</div>
                        <div class="text-xs text-muted">Live operator panels and active services.</div>
                    </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                    <span class="text-2xs text-subtle">{{ runningCount }}</span>
                    <Icon name="chevron-right" class="text-2xs text-subtle" />
                </div>
            </RouterLink>

            <RouterLink
                to="/sandbox/access"
                class="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2 transition-colors hover:border-line-strong hover:bg-overlay"
            >
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="users" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <div class="font-medium text-content">Access</div>
                        <div class="text-xs text-muted">Who can reach this sandbox.</div>
                    </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                    <span v-if="othersHere > 0" class="text-2xs text-success">{{ othersHere }} here now</span>
                    <Icon name="chevron-right" class="text-2xs text-subtle" />
                </div>
            </RouterLink>
        </Card>
    </div>
</template>
