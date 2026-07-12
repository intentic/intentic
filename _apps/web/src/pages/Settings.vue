<script setup lang="ts">
import type { SandboxSettings } from "@intentic-app/api-contract";
import { Card, cmp, Page, useExplorerStyle, useIconSet, useTheme } from "@intentic-app/ui";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { fileToSquareDataUrl } from "../composables/imageDataUrl";
import { apiClient } from "../composables/useApi";
import { useAuth } from "../composables/useAuth";
import { useSandboxSettings } from "../composables/sandbox/useSandboxSettings";
import { explorerTreatment } from "./workspace/fileIcon";
import ImportMemoryDialog from "./ImportMemoryDialog.vue";

/* Personal preferences for the signed-in account. A dedicated surface (not the account popover) so it can
 * grow past the single theme toggle without becoming a junk drawer. */

const { scheme, set: setScheme, theme, setTheme, themes } = useTheme();
const { iconSet, iconSets } = useIconSet();
const { explorerStyle, explorerStyles } = useExplorerStyle();

// A few representative rows so the Explorer setup is visible here without opening the workspace.
const explorerPreview: { name: string; type: "file" | "dir" }[] = [
    { name: `monorepo`, type: `dir` },
    { name: `package.json`, type: `file` },
    { name: `index.ts`, type: `file` },
    { name: `theme.css`, type: `file` },
    { name: `schema.prisma`, type: `file` },
];
const treatPreview = (entry: { name: string; type: "file" | "dir" }) =>
    explorerTreatment(explorerStyle.value, entry.name, entry.type, entry.type === `dir`, false);
const { user, updateProfile, deleteAccount } = useAuth();
const router = useRouter();

const importOpen = ref(false);

// Per-sandbox agent settings (search-past-chats + the experimental toggles below). Stored in the sandbox daemon
// (undefined until the active sandbox is reachable), so the toggles are disabled while it loads.
const { settings: sandboxSettings, save: saveSandboxSettings } = useSandboxSettings();
// Persisting one flag sends the WHOLE object (the daemon validates the full schema and `save` overwrites it), so
// merge the change onto the current values. Only ever fired by a toggle that's disabled until settings load.
const setSandboxFlag = (change: Partial<SandboxSettings>): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, ...change });
};

// Profile: display name + avatar, saved via Better Auth's update-user (useAuth.updateProfile). The picked
// file becomes a small square data URL in the browser — no upload. Re-seeded from the shared user ref, so a
// save (which refreshes the session) syncs the form back to what the server stored.
const profileName = ref(user.value?.name ?? ``);
watch(user, (value) => {
    profileName.value = value?.name ?? ``;
});
// A freshly picked avatar, previewed until Save sends it. Undefined = keep the current one.
const stagedAvatar = ref<string | undefined>(undefined);
const avatarInput = ref<HTMLInputElement | null>(null);
const avatarFailed = ref(false);
const avatarImage = computed(() => stagedAvatar.value ?? (avatarFailed.value ? undefined : (user.value?.image ?? undefined)));
const saving = ref(false);
const saveError = ref<string | undefined>(undefined);

const pickAvatar = async (event: Event): Promise<void> => {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = ``;
    if (file === undefined) {
        return;
    }
    saveError.value = undefined;
    try {
        stagedAvatar.value = await fileToSquareDataUrl(file);
    } catch {
        saveError.value = `Couldn't read that file as an image.`;
    }
};

const canSaveProfile = computed(() => {
    const trimmed = profileName.value.trim();
    return trimmed.length > 0 && trimmed.length <= 60 && (trimmed !== user.value?.name || stagedAvatar.value !== undefined);
});

const saveProfile = async (): Promise<void> => {
    const trimmed = profileName.value.trim();
    if (saving.value || !canSaveProfile.value) {
        return;
    }
    saving.value = true;
    saveError.value = undefined;
    try {
        await updateProfile({
            ...(trimmed !== user.value?.name && { name: trimmed }),
            ...(stagedAvatar.value !== undefined && { image: stagedAvatar.value }),
        });
        stagedAvatar.value = undefined;
        avatarFailed.value = false;
    } catch (error) {
        saveError.value = error instanceof Error ? error.message : `Profile update failed.`;
    } finally {
        saving.value = false;
    }
};

// GDPR data export: download everything the platform stores about the account as JSON (me.export).
const exporting = ref(false);
const exportData = async (): Promise<void> => {
    exporting.value = true;
    try {
        const data = await apiClient.me.export();
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, undefined, 2)], { type: `application/json` }));
        const link = document.createElement(`a`);
        link.href = url;
        link.download = `intentic-data-export.json`;
        link.click();
        URL.revokeObjectURL(url);
    } finally {
        exporting.value = false;
    }
};

// GDPR account deletion: two-step inline confirm, then Better Auth deletes the Stripe customer + user row
// (cascading sandboxes, sessions and grants) and we land back on the login page.
const confirmingDelete = ref(false);
const deleting = ref(false);
const deleteError = ref<string | undefined>(undefined);
const confirmDelete = async (): Promise<void> => {
    deleting.value = true;
    deleteError.value = undefined;
    try {
        await deleteAccount();
        await router.push(`/login`);
    } catch (error) {
        deleteError.value = error instanceof Error ? error.message : `Account deletion failed.`;
    } finally {
        deleting.value = false;
    }
};
</script>

<template>
    <Page>
        <header class="mb-6">
            <h1 class="text-2xl font-semibold">Settings</h1>
            <p class="mt-1 text-sm text-muted">Your personal preferences on this platform.</p>
        </header>

        <div class="flex flex-col gap-2.5">
            <!-- Profile: how the account appears — avatar + display name. -->
            <Card>
                <form @submit.prevent="saveProfile">
                    <div class="flex items-center gap-2.5">
                        <Icon name="user" class="text-lg text-muted" />
                        <div>
                            <h2 class="font-semibold leading-tight">Profile</h2>
                            <p class="text-xs text-muted">Your display name and avatar on this platform.</p>
                        </div>
                    </div>
                    <div class="mt-3 flex items-center gap-3">
                        <span
                            class="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-canvas text-muted"
                        >
                            <img
                                v-if="avatarImage"
                                :src="avatarImage"
                                alt=""
                                referrerpolicy="no-referrer"
                                class="h-full w-full object-cover"
                                @error="avatarFailed = true"
                            />
                            <Icon name="user" v-else class="text-xl" />
                        </span>
                        <Button label="Change avatar" severity="secondary" :outlined="true" size="small" @click="avatarInput?.click()">
                            <template #icon><Icon name="image" /></template>
                        </Button>
                        <input ref="avatarInput" type="file" accept="image/*" class="hidden" @change="pickAvatar" />
                    </div>
                    <label class="mt-3 flex flex-col gap-1">
                        <span class="text-xs font-medium text-muted">Display name</span>
                        <input v-model="profileName" type="text" autocomplete="off" maxlength="60" :class="cmp.input('w-full')" />
                    </label>
                    <div class="mt-3 flex justify-end">
                        <Button type="submit" label="Save" size="small" :loading="saving" :disabled="saving || !canSaveProfile" />
                    </div>
                    <p v-if="saveError" class="mt-2 text-2xs text-danger">{{ saveError }}</p>
                </form>
            </Card>

            <!-- Color scheme — flips the data-mode attribute, recoloring PrimeVue + Tailwind together. -->
            <Card class="flex items-center justify-between">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon class="text-lg text-muted" :name="scheme === 'dark' ? 'moon' : 'sun'" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">Theme</h2>
                        <p class="text-xs text-muted">Light or dark appearance for the workspace.</p>
                    </div>
                </div>
                <div class="flex shrink-0 items-center gap-0.5 rounded-md border border-line p-0.5">
                    <button
                        type="button"
                        class="rounded px-2.5 py-1 text-xs font-medium transition-colors"
                        :class="scheme === 'light' ? 'bg-content/10 text-content' : 'text-muted hover:text-content'"
                        @click="setScheme('light')"
                    >
                        Light
                    </button>
                    <button
                        type="button"
                        class="rounded px-2.5 py-1 text-xs font-medium transition-colors"
                        :class="scheme === 'dark' ? 'bg-content/10 text-content' : 'text-muted hover:text-content'"
                        @click="setScheme('dark')"
                    >
                        Dark
                    </button>
                </div>
            </Card>

            <!-- Brand theme — flips the data-theme attribute; composes with the light/dark scheme above. -->
            <Card class="flex items-center justify-between">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="palette" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">Style</h2>
                        <p class="text-xs text-muted">Colors, type and shape of the workspace.</p>
                    </div>
                </div>
                <div class="flex shrink-0 flex-wrap items-center gap-0.5 rounded-md border border-line p-0.5">
                    <button
                        v-for="option in themes"
                        :key="option"
                        type="button"
                        class="rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors"
                        :class="theme === option ? 'bg-content/10 text-content' : 'text-muted hover:text-content'"
                        @click="setTheme(option)"
                    >
                        {{ option }}
                    </button>
                </div>
            </Card>

            <!-- Icon set — the whole app's icons re-render live from the picked set (no reload), so the whole UI
                 is the preview. A comparison surface while we settle on a single set. -->
            <Card class="flex items-center justify-between">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="sparkles" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">Icons</h2>
                        <p class="text-xs text-muted">Which icon set the workspace draws with.</p>
                    </div>
                </div>
                <div class="flex shrink-0 items-center gap-0.5 rounded-md border border-line p-0.5">
                    <button
                        v-for="option in iconSets"
                        :key="option"
                        type="button"
                        class="rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors"
                        :class="iconSet === option ? 'bg-content/10 text-content' : 'text-muted hover:text-content'"
                        @click="iconSet = option"
                    >
                        {{ option }}
                    </button>
                </div>
            </Card>

            <!-- Explorer setup — size, colour and folder emphasis of the workspace file tree. The tree isn't on
                 this page, so a small live preview renders the current pick (repaints instantly on switch). -->
            <Card>
                <div class="flex items-center justify-between">
                    <div class="flex min-w-0 items-center gap-2.5">
                        <Icon name="sitemap" class="text-lg text-muted" />
                        <div class="min-w-0">
                            <h2 class="font-semibold leading-tight">Explorer</h2>
                            <p class="text-xs text-muted">Size, colour and emphasis of the file tree.</p>
                        </div>
                    </div>
                    <div class="flex shrink-0 items-center gap-0.5 rounded-md border border-line p-0.5">
                        <button
                            v-for="option in explorerStyles"
                            :key="option"
                            type="button"
                            class="rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors"
                            :class="explorerStyle === option ? 'bg-content/10 text-content' : 'text-muted hover:text-content'"
                            @click="explorerStyle = option"
                        >
                            {{ option }}
                        </button>
                    </div>
                </div>
                <div class="mt-3 rounded-md border border-line bg-canvas p-2">
                    <div v-for="entry in explorerPreview" :key="entry.name" class="flex items-center gap-1.5 py-0.5 text-[0.8125rem]">
                        <span class="w-[0.7rem] shrink-0"></span>
                        <span class="flex shrink-0 items-center justify-center" :class="treatPreview(entry).slotClass">
                            <Icon :name="treatPreview(entry).icon" :class="[treatPreview(entry).sizeClass, treatPreview(entry).colorClass]" />
                        </span>
                        <span class="truncate text-content/90">{{ entry.name }}</span>
                    </div>
                </div>
            </Card>

            <!-- Past-chat search — lets the agent look through the active sandbox's earlier conversations. Stored
                 per-sandbox in the daemon, so it's disabled until the active sandbox is reachable. -->
            <Card class="flex items-center justify-between">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="history" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">Search past chats</h2>
                        <p class="text-xs text-muted">Let the assistant search the active sandbox's earlier conversations for relevant details.</p>
                    </div>
                </div>
                <ToggleSwitch
                    :model-value="sandboxSettings?.searchPastChats ?? false"
                    :disabled="sandboxSettings === undefined"
                    @update:model-value="setSandboxFlag({ searchPastChats: $event })"
                />
            </Card>

            <!-- Experimental agent-harness toggles: each is opt-in and independently benchmarkable (watch the
                 per-turn usage/cost the agent reports). Stored per-sandbox in the daemon like Search past chats. -->
            <h2 class="mt-4 px-1 text-xs font-semibold uppercase tracking-wide text-subtle">Experimental</h2>

            <!-- Prompt-cache optimization — keeps the system prompt byte-stable so the provider prompt cache
                 survives across turns (cross-agent delegation hints ride the message, not the system prompt). -->
            <Card class="flex items-center justify-between">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="bolt" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">Prompt-cache optimization</h2>
                        <p class="text-xs text-muted">Keep the system prompt stable across turns so the model's prompt cache is reused — cuts cost on longer chats.</p>
                    </div>
                </div>
                <ToggleSwitch
                    :model-value="sandboxSettings?.stableSystemPrompt ?? false"
                    :disabled="sandboxSettings === undefined"
                    @update:model-value="setSandboxFlag({ stableSystemPrompt: $event })"
                />
            </Card>

            <!-- LSP code tools — surfaces the `lsp` CLI (rename + diagnostics over the TypeScript language server)
                 to the agent via its skill, so refactors update every import and edits are compiler-checked. -->
            <Card class="flex items-center justify-between">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="code" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">LSP code tools</h2>
                        <p class="text-xs text-muted">Give the agent language-server rename and diagnostics so refactors update every usage and edits are compiler-checked.</p>
                    </div>
                </div>
                <ToggleSwitch
                    :model-value="sandboxSettings?.lspTools ?? false"
                    :disabled="sandboxSettings === undefined"
                    @update:model-value="setSandboxFlag({ lspTools: $event })"
                />
            </Card>

            <!-- Hash-anchored edits — swaps the agent's file-edit tools for hash-anchored patches: rejects edits to
                 a file that changed since it was read, and uses fewer output tokens. Claude agent only for now. -->
            <Card class="flex items-center justify-between">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="file-edit" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">Hash-anchored edits</h2>
                        <p class="text-xs text-muted">Anchor the agent's edits to content hashes — safer on changed files and fewer output tokens. Claude agent only.</p>
                    </div>
                </div>
                <ToggleSwitch
                    :model-value="sandboxSettings?.hashlineEdits ?? false"
                    :disabled="sandboxSettings === undefined"
                    @update:model-value="setSandboxFlag({ hashlineEdits: $event })"
                />
            </Card>

            <!-- Import memory: bring context from another AI assistant into the active sandbox's agent memory files. -->
            <Card class="flex items-center justify-between">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="sparkles" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">Import memory</h2>
                        <p class="text-xs text-muted">
                            Bring context from another AI assistant into this workspace so Claude and ChatGPT remember it.
                        </p>
                    </div>
                </div>
                <Button label="Import" severity="secondary" :outlined="true" size="small" @click="importOpen = true" />
            </Card>

            <!-- Privacy & data: GDPR self-service (export + deletion). -->
            <Card class="flex items-center justify-between">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="download" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">Export my data</h2>
                        <p class="text-xs text-muted">Download everything the platform stores about your account as JSON.</p>
                    </div>
                </div>
                <Button label="Export" severity="secondary" :outlined="true" size="small" :loading="exporting" @click="exportData" />
            </Card>

            <Card>
                <div class="flex items-center justify-between gap-3">
                    <div class="flex min-w-0 items-center gap-2.5">
                        <Icon name="trash" class="text-lg text-danger" />
                        <div class="min-w-0">
                            <h2 class="font-semibold leading-tight">Delete account</h2>
                            <p class="text-xs text-muted">
                                Permanently removes your account, sandboxes, shared access and billing data. Cannot be undone.
                            </p>
                        </div>
                    </div>
                    <Button
                        v-if="!confirmingDelete"
                        label="Delete"
                        severity="danger"
                        :outlined="true"
                        size="small"
                        @click="confirmingDelete = true"
                    />
                </div>
                <div v-if="confirmingDelete" class="mt-3 flex items-center justify-end gap-2 border-t border-line pt-3">
                    <span class="mr-auto text-2xs text-subtle">Are you sure? This deletes everything immediately.</span>
                    <Button label="Cancel" severity="secondary" text size="small" :disabled="deleting" @click="confirmingDelete = false" />
                    <Button label="Delete my account" severity="danger" size="small" :loading="deleting" @click="confirmDelete" />
                </div>
                <p v-if="deleteError" class="mt-2 text-2xs text-danger">{{ deleteError }}</p>
            </Card>
        </div>

        <ImportMemoryDialog v-model:visible="importOpen" />
    </Page>
</template>
