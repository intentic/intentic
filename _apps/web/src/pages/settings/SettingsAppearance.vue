<script setup lang="ts">
import { Card, useExplorerStyle, useIconSet, useTheme } from "@intentic-app/ui";
import { explorerTreatment } from "../workspace/fileIcon";

/* Appearance: how the workspace looks for this account — color scheme (data-mode), brand style (data-theme),
 * icon set, and file-tree treatment. Each recolors/re-renders the whole UI live, so most of the app is the
 * preview; the Explorer gets a small inline sample because its tree isn't on this page. */

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
    </div>
</template>
