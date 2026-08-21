<script setup lang="ts">
import { ColorPicker, Row, RowGroup, SegmentedControl, useExplorerStyle, useTextSize, useTheme } from "@intentic/ui";
import { explorerTreatment, type IconName } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { useToolCalls } from "../../composables/chat/useToolCalls";
import { showWorkTerminals } from "../../composables/terminal/useWorkTerminals";
import { useLayout } from "../../composables/useLayout";
import { useChangeGrouping } from "../../composables/workspace/useChangeGrouping";
import { useFileNesting } from "../../composables/workspace/useFileNesting";
import { useImportedTheme } from "../../composables/theme/useImportedTheme";
import { useIconRailSize } from "../../composables/useIconRailSize";
import { type Skin, useSkin } from "../../skins/useSkin";

/* Appearance: how the workspace looks for this account: the color scheme (data-mode), the one colour the whole app
 * is built out of, file-tree treatment, which tabs the terminal strip carries, and an imported VSCode/OpenVSX
 * theme. Each recolors/re-renders the whole UI
 * live, so most of the app is the preview; the Explorer gets a small inline sample because its tree isn't on
 * this page. Laid out as grouped rows (RowGroup/Row) rather than a card per option, with the borderless
 * SegmentedControl control and the Explorer preview flush in the row's #below. */

const { scheme, set: setScheme, accent, setAccent } = useTheme();
const { textSize, setTextSize } = useTextSize();
const { explorerStyle, explorerStyles } = useExplorerStyle();
const { iconRailSize } = useIconRailSize();
const { fileNesting } = useFileNesting();
// The review lists' reading, the same preference the Changes panel's own header toggle flips.
const { groupByModule } = useChangeGrouping();
// How much of an agent's working-out a transcript shows, the same preference the chat's own readout row flips,
// which is where somebody staring at a run mark will reach for it; this is where they'll look to decide it once.
const { showToolCalls } = useToolCalls();
// The explorer's two filters, the same preferences the workspace toolbar's funnel flips, which is where someone
// already staring at node_modules will reach for them; this is where they'll look for them afterwards.
// skipImports has no such second home: it decides where a diff OPENS, so a control on the diff itself would look
// like it did nothing at all. This page is the only place it can be asked for.
const { showIgnored, toggleShowIgnored, hideTests, toggleHideTests, skipImports, toggleSkipImports } = useLayout();

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

// SegmentedControl option lists: labels capitalized, values are the raw token strings the composables store.
const cap = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/* ── SKINS ────────────────────────────────────────────────────────────────────────────────────────────────
 * A skin is a whole-interface look rather than a colour (src/skins/README.md), and it rides the THEME row
 * alongside the two colour schemes because "which theme am I in" is one question. Asked as two controls it
 * becomes two, and someone ends up sitting in a light scheme with a dark instrument panel drawn over it,
 * looking for the switch that undoes it.
 *
 * So the value is the skin when one is on and the colour scheme otherwise, and picking a scheme drops the
 * skin: one row, one answer, no state you can get into that the row cannot show you.
 *
 * TO REMOVE SKINS ENTIRELY: delete this block and the `useSkin` import, leave `light`/`dark` in the options, and
 * put `:model-value="scheme"` / `@update:model-value="setScheme"` back on the row's control. */
const { skin, setSkin } = useSkin();
type ThemeChoice = "light" | "dark" | Skin;
const themeOptions = [
    { label: `Light`, value: `light` as const },
    { label: `Dark`, value: `dark` as const },
    { label: `HUD`, value: `hud` as const, title: `A heads-up display: glass panels, lit edges and a survey grid, in the colour you picked below.` },
    {
        label: `Sanctum`,
        value: `sanctum` as const,
        title: `The look of intentic.dev: ash stone, a gold rule round every panel, carved and cast plaques, and the site's own type.`,
    },
];
// The row's lead glyph names the look rather than the light level, which is what the row now chooses.
const THEME_ICON: Record<ThemeChoice, IconName> = { light: `sun`, dark: `moon`, hud: `wave-pulse`, sanctum: `star-fill`, none: `moon` };
const themeChoice = computed<ThemeChoice>(() => (skin.value === `none` ? scheme.value : skin.value));
const setThemeChoice = (value: ThemeChoice): void => {
    // Both skins are built for a near-black canvas and PrimeVue keys its own dark components off the scheme, so
    // useSkin flips it, so nothing to do here beyond naming the skin.
    if (value !== `light` && value !== `dark`) {
        setSkin(value);
        return;
    }
    setSkin(`none`);
    setScheme(value);
};
const explorerOptions = computed(() => explorerStyles.map((value) => ({ label: cap(value), value })));
const iconRailOptions = [
    { label: `Compact`, value: `compact` as const },
    { label: `Comfortable`, value: `comfortable` as const },
];
// Named for what they do to the reading, not for the percentages behind them (useTextSize owns those): "110%"
// is the browser control this setting exists to replace, and repeating its number here would invite someone to
// set both.
const textSizeOptions = [
    { label: `Compact`, value: `compact` as const },
    { label: `Default`, value: `default` as const },
    { label: `Large`, value: `large` as const },
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
        <!-- Look: whole-workspace appearance choices. -->
        <RowGroup label="Look">
            <Row
                :icon="THEME_ICON[themeChoice]"
                title="Theme"
                description="The workspace's whole look: plain light and dark, the HUD's lit glass over a survey grid, or the Sanctum's gilded stone."
            >
                <template #control
                    ><SegmentedControl :model-value="themeChoice" :options="themeOptions" @update:model-value="setThemeChoice"
                /></template>
            </Row>
            <!-- The colour the rest of the workspace is built out of. In #below rather than #control because it
                 is two rails and a row of swatches, and because the app around it repaints as they move, a
                 control this wide beside a title would push the description into a column. -->
            <Row
                icon="palette"
                title="Colour"
                description="The accent everything is built from: links, buttons, highlights and the tint of every surface."
            >
                <template #below>
                    <ColorPicker :model-value="accent" @update:model-value="setAccent" />
                </template>
            </Row>
            <!-- Above the rail row on purpose: this one moves the whole workspace, that one moves a column of it. -->
            <Row icon="expand" title="Text size" description="How large everything reads: text, spacing and controls together.">
                <template #control
                    ><SegmentedControl :model-value="textSize" :options="textSizeOptions" @update:model-value="setTextSize"
                /></template>
            </Row>
            <Row icon="sliders-h" title="Icon rail" description="Width and spacing of the desktop navigation rail.">
                <template #control>
                    <SegmentedControl
                        :model-value="iconRailSize"
                        :options="iconRailOptions"
                        @update:model-value="(value) => (iconRailSize = value)"
                    />
                </template>
            </Row>
        </RowGroup>

        <!-- File tree: the explorer's look, with its live preview flush under the row (no boxed inset). -->
        <RowGroup label="File tree">
            <Row icon="sitemap" title="Explorer" description="Size, colour and emphasis of the file tree.">
                <template #control>
                    <SegmentedControl
                        :model-value="explorerStyle"
                        :options="explorerOptions"
                        @update:model-value="(value) => (explorerStyle = value)"
                    />
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
                description="List node_modules, build output and .gitignore'd paths in the explorer, grayed out. This is the whole filesystem the agent sees."
            >
                <template #control>
                    <ToggleSwitch :model-value="showIgnored" @update:model-value="toggleShowIgnored()" />
                </template>
            </Row>
            <Row
                as="label"
                icon="filter"
                title="Hide tests"
                description="Leave test and spec files out of the explorer: the .test and .spec files and the __tests__ folders beside them."
            >
                <template #control>
                    <ToggleSwitch :model-value="hideTests" @update:model-value="toggleHideTests()" />
                </template>
            </Row>
        </RowGroup>

        <!-- Changes: how a review reads: its list of files, and where each diff opens. Grouping is here as well
             as on the panel itself (the Changes header's own toggle writes the same preference), for the same
             reason the explorer's switches are in both places: this is where someone looks for it once they know
             it exists. Both apply to the workspace's Changes tab and an agent's review alike. -->
        <RowGroup label="Changes">
            <Row
                as="label"
                icon="box"
                title="Group by module"
                description="Head each run of changed files with the package it lives in, and let the row be the file rather than a repo-relative path. Applies to agent reviews too."
            >
                <template #control><ToggleSwitch v-model="groupByModule" /></template>
            </Row>
            <Row
                as="label"
                icon="forward"
                title="Open past the imports"
                description="Open every diff on the first change that isn't an import, instead of on the import list at the top of the file. The imports are still there to scroll up to, and a file whose only changes are imports opens on those."
            >
                <template #control>
                    <ToggleSwitch :model-value="skipImports" @update:model-value="toggleSkipImports()" />
                </template>
            </Row>
        </RowGroup>

        <!-- Chat: how much of an agent's working-out a transcript shows. Off, each turn's run of calls sits
             behind one mark you can open; on, every call is a row, which is what someone debugging an agent
             rather than reading its answer wants. Also flipped from the chat itself, for the same reason the
             explorer's switches are in both places. -->
        <RowGroup label="Chat">
            <Row
                as="label"
                icon="eye"
                title="Show tool calls"
                description="List every command, file read and edit an agent makes as its own row. Off, a turn's calls fold into one mark between messages that opens when you click it."
            >
                <template #control><ToggleSwitch v-model="showToolCalls" /></template>
            </Row>
        </RowGroup>

        <!-- Terminal: what the panel's strip carries. The terminals work runs in are hidden by default (they're
             evidence about something that ran, not tabs you keep (useWorkTerminals). This is the sticky way
             back. The same preference is a checked row in the panel's own right-click menu and the
             work-terminals popover's footer, which is where someone irritated by it will actually reach. -->
        <RowGroup label="Terminal">
            <Row as="label" icon="sparkles" title="Work terminals" description="Give every agent and job terminal its own tab in the terminal panel.">
                <template #control><ToggleSwitch v-model="showWorkTerminals" /></template>
            </Row>
        </RowGroup>

        <!-- Theme import: the one row that needs a full-width editor. Its body lives in #below. -->
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
