<script setup lang="ts">
import { Card, useExplorerStyle, useIconSet, useTheme } from "@intentic-app/ui";
import { explorerTreatment } from "@intentic-app/ui";
import { ref } from "vue";
import { useFileNesting } from "../../composables/workspace/useFileNesting";
import { useImportedTheme } from "../../composables/theme/useImportedTheme";

/* Appearance: how the workspace looks for this account — color scheme (data-mode), brand style (data-theme),
 * icon set, file-tree treatment, and an imported VSCode/OpenVSX theme. Each recolors/re-renders the whole UI live,
 * so most of the app is the preview; the Explorer gets a small inline sample because its tree isn't on this page. */

const { scheme, set: setScheme, theme, setTheme, themes } = useTheme();
const { iconSet, iconSets } = useIconSet();
const { explorerStyle, explorerStyles } = useExplorerStyle();
const { fileNesting } = useFileNesting();

// Import a VSCode theme JSON → recolor the app's chrome tokens live (the biggest "familiar for developers" lever).
const { active: importedTheme, importThemeJson, clearImportedTheme } = useImportedTheme();
const themeJson = ref(``);
const importError = ref<string | undefined>(undefined);
const applyImport = (): void => {
    importError.value = undefined;
    try {
        importThemeJson(themeJson.value);
        themeJson.value = ``;
    } catch (caught) {
        importError.value = caught instanceof Error ? `Couldn't read that theme: ${caught.message}` : `Could not parse the theme JSON.`;
    }
};

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
</script>

<template>
    <div class="flex flex-col gap-2.5">
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

        <!-- File nesting — opinionated, binary: every explorer directory with a package.json folds its other
             files under it. No per-pattern rules to configure. -->
        <Card class="flex items-center justify-between">
            <div class="flex min-w-0 items-center gap-2.5">
                <Icon name="folder-open" class="text-lg text-muted" />
                <div class="min-w-0">
                    <h2 class="font-semibold leading-tight">File nesting</h2>
                    <p class="text-xs text-muted">Fold a folder's files under its package.json in the explorer.</p>
                </div>
            </div>
            <div class="flex shrink-0 items-center gap-0.5 rounded-md border border-line p-0.5">
                <button
                    type="button"
                    class="rounded px-2.5 py-1 text-xs font-medium transition-colors"
                    :class="fileNesting ? 'bg-content/10 text-content' : 'text-muted hover:text-content'"
                    @click="fileNesting = true"
                >
                    On
                </button>
                <button
                    type="button"
                    class="rounded px-2.5 py-1 text-xs font-medium transition-colors"
                    :class="!fileNesting ? 'bg-content/10 text-content' : 'text-muted hover:text-content'"
                    @click="fileNesting = false"
                >
                    Off
                </button>
            </div>
        </Card>

        <!-- Import a VSCode / OpenVSX color theme — paste its JSON and the app's chrome tokens recolor live. The
             biggest familiarity lever: bring the exact look you use in VSCode. Maps the identity chrome tokens
             (canvas, text, borders, accent); syntax colors and full ramps are a later pass. -->
        <Card>
            <div class="flex items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="palette" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">Import a VSCode theme</h2>
                        <p class="text-xs text-muted">Paste a VSCode / OpenVSX color theme JSON to recolor the workspace.</p>
                    </div>
                </div>
                <button
                    v-if="importedTheme"
                    type="button"
                    class="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-content"
                    @click="clearImportedTheme()"
                >
                    Remove
                </button>
            </div>

            <p v-if="importedTheme" class="mt-2 inline-flex items-center gap-1.5 text-xs text-muted">
                <Icon name="check-circle" class="text-success" />
                Active: <b class="text-content">{{ importedTheme.name }}</b> · {{ importedTheme.mode }}
            </p>

            <textarea
                v-model="themeJson"
                rows="4"
                spellcheck="false"
                placeholder='Paste theme JSON, e.g. { "type": "dark", "colors": { "editor.background": "#1e1e1e", … } }'
                class="scrollbar-thin mt-3 w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-content placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-primary-500"
            ></textarea>

            <div v-if="importError" class="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{{ importError }}</div>

            <div class="mt-2 flex justify-end">
                <button
                    type="button"
                    class="rounded-md bg-primary-600/15 px-3 py-1 text-xs font-medium text-link transition-colors hover:bg-primary-600/25 disabled:opacity-40"
                    :disabled="themeJson.trim().length === 0"
                    @click="applyImport()"
                >
                    Apply theme
                </button>
            </div>
        </Card>
    </div>
</template>
