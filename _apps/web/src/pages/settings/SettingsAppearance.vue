<script setup lang="ts">
import { Row, RowGroup, Segmented, useExplorerStyle, useIconSet, useTheme } from "@intentic/ui";
import { explorerTreatment } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { showWorkTerminals } from "../../composables/terminal/useWorkTerminals";
import { useLayout } from "../../composables/useLayout";
import { useChangeGrouping } from "../../composables/workspace/useChangeGrouping";
import { useFileNesting } from "../../composables/workspace/useFileNesting";
import { useImportedTheme } from "../../composables/theme/useImportedTheme";
import { useIconRailSize } from "../../composables/useIconRailSize";

/* Appearance: how the workspace looks for this account — color scheme (data-mode), brand style (data-theme),
 * icon set, file-tree treatment, which tabs the terminal strip carries, and an imported VSCode/OpenVSX theme.
 * Each recolors/re-renders the whole UI
 * live, so most of the app is the preview; the Explorer gets a small inline sample because its tree isn't on
 * this page. Laid out as grouped rows (RowGroup/Row) rather than a card per option, with the borderless
 * Segmented control and the Explorer preview flush in the row's #below. */

const { scheme, set: setScheme, theme, setTheme, themes } = useTheme();
const { iconSet, iconSets } = useIconSet();
const { explorerStyle, explorerStyles } = useExplorerStyle();
const { iconRailSize } = useIconRailSize();
const { fileNesting } = useFileNesting();
// The review lists' reading — the same preference the Changes panel's own header toggle flips.
const { groupByModule } = useChangeGrouping();
// The explorer's ignored-entry switch — the same preference the workspace toolbar's Ignored chip flips, which is
// where someone already staring at node_modules will reach for it; this is where they'll look for it afterwards.
const { showIgnored, toggleShowIgnored } = useLayout();

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

// Segmented option lists — labels capitalized, values are the raw token strings the composables store.
const cap = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
const schemeOptions = [
    { label: `Light`, value: `light` as const },
    { label: `Dark`, value: `dark` as const },
];
const themeOptions = computed(() => themes.map((value) => ({ label: cap(value), value })));
const iconOptions = computed(() => iconSets.map((value) => ({ label: cap(value), value })));
const explorerOptions = computed(() => explorerStyles.map((value) => ({ label: cap(value), value })));
const iconRailOptions = [
    { label: `Compact`, value: `compact` as const },
    { label: `Comfortable`, value: `comfortable` as const },
];

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
    <div class="flex flex-col gap-6">
        <!-- Look — whole-workspace appearance choices. -->
        <RowGroup label="Look">
            <Row :icon="scheme === `dark` ? `moon` : `sun`" title="Theme" description="Light or dark appearance for the workspace.">
                <template #control><Segmented :model-value="scheme" :options="schemeOptions" @update:model-value="setScheme" /></template>
            </Row>
            <Row icon="palette" title="Style" description="Colors, type and shape of the workspace.">
                <template #control><Segmented :model-value="theme" :options="themeOptions" @update:model-value="setTheme" /></template>
            </Row>
            <Row icon="sparkles" title="Icons" description="Which icon set the workspace draws with.">
                <template #control>
                    <Segmented :model-value="iconSet" :options="iconOptions" @update:model-value="(value) => (iconSet = value)" />
                </template>
            </Row>
            <Row icon="sliders-h" title="Icon rail" description="Width and spacing of the desktop navigation rail.">
                <template #control>
                    <Segmented :model-value="iconRailSize" :options="iconRailOptions" @update:model-value="(value) => (iconRailSize = value)" />
                </template>
            </Row>
        </RowGroup>

        <!-- File tree — the explorer's look, with its live preview flush under the row (no boxed inset). -->
        <RowGroup label="File tree">
            <Row icon="sitemap" title="Explorer" description="Size, colour and emphasis of the file tree.">
                <template #control>
                    <Segmented :model-value="explorerStyle" :options="explorerOptions" @update:model-value="(value) => (explorerStyle = value)" />
                </template>
                <template #below>
                    <div class="flex flex-col gap-0.5 pl-[1.85rem]">
                        <div v-for="entry in explorerPreview" :key="entry.name" class="flex items-center gap-1.5 py-0.5 text-[0.8125rem]">
                            <span class="flex shrink-0 items-center justify-center" :class="treatPreview(entry).slotClass">
                                <Icon :name="treatPreview(entry).icon" :class="[treatPreview(entry).sizeClass, treatPreview(entry).colorClass]" />
                            </span>
                            <span class="truncate text-content/80">{{ entry.name }}</span>
                        </div>
                    </div>
                </template>
            </Row>
            <Row as="label" icon="folder-open" title="File nesting" description="Fold a folder's files under its package.json in the explorer.">
                <template #control><ToggleSwitch v-model="fileNesting" /></template>
            </Row>
            <Row
                as="label"
                icon="eye"
                title="Show ignored files"
                description="List node_modules, build output and .gitignore'd paths in the explorer, grayed — the whole filesystem the agent sees. Off by default, so the tree is the project alone."
            >
                <template #control>
                    <ToggleSwitch :model-value="showIgnored" @update:model-value="toggleShowIgnored()" />
                </template>
            </Row>
        </RowGroup>

        <!-- Changes — how a review list reads. Here as well as on the panel itself (the Changes header's own
             toggle writes the same preference), for the same reason the explorer's switches are in both places:
             this is where someone looks for it once they know it exists. -->
        <RowGroup label="Changes">
            <Row
                as="label"
                icon="box"
                title="Group by module"
                description="Head each run of changed files with the package it lives in, and let the row be the file — instead of a repo-relative path per row. On by default; a repo with no package manifests keeps its paths. Applies to the workspace Changes panel and an agent's review."
            >
                <template #control><ToggleSwitch v-model="groupByModule" /></template>
            </Row>
        </RowGroup>

        <!-- Terminal — what the panel's strip carries. The terminals work runs in are hidden by default (they're
             evidence about something that ran, not tabs you keep — useWorkTerminals); this is the sticky way
             back. The same preference is a checked row in the panel's own right-click menu and the
             work-terminals popover's footer, which is where someone irritated by it will actually reach. -->
        <RowGroup label="Terminal">
            <Row as="label" icon="sparkles" title="Work terminals" description="Give every agent and job terminal its own tab in the terminal panel.">
                <template #control><ToggleSwitch v-model="showWorkTerminals" /></template>
            </Row>
        </RowGroup>

        <!-- Theme import — the one row that needs a full-width editor; its body lives in #below. -->
        <RowGroup label="Theme import">
            <Row icon="palette" title="Import a VSCode theme" description="Paste a VSCode / OpenVSX color theme JSON to recolor the workspace.">
                <template #control>
                    <button
                        v-if="importedTheme"
                        type="button"
                        class="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-content"
                        @click="clearImportedTheme()"
                    >
                        Remove
                    </button>
                </template>
                <template #below>
                    <p v-if="importedTheme" class="mb-2 inline-flex items-center gap-1.5 text-xs text-muted">
                        <Icon name="check-circle" class="text-success" />
                        Active: <b class="text-content">{{ importedTheme.name }}</b> · {{ importedTheme.mode }}
                    </p>
                    <textarea
                        v-model="themeJson"
                        rows="4"
                        spellcheck="false"
                        placeholder='Paste theme JSON, e.g. { "type": "dark", "colors": { "editor.background": "#1e1e1e", … } }'
                        class="scrollbar-thin w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-content placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-primary-500"
                    ></textarea>
                    <div v-if="importError" class="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                        {{ importError }}
                    </div>
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
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
