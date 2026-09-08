<script setup lang="ts">
import {
    ColorPicker,
    Row,
    RowGroup,
    SegmentedControl,
    useExplorerStyle,
    useTextSize,
    useTheme,
    explorerTreatment,
    type IconName,
} from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useToolCalls } from "../chat/tools/useToolCalls";
import { showWorkTerminals } from "../terminal/useWorkTerminals";
import { type DiffOpen, useLayout } from "../../shell/window/useLayout";
import { useChangeGrouping } from "../workspace/changes/useChangeGrouping";
import { useChangeWeight } from "../workspace/changes/changeWeight";
import { useFileNesting } from "../workspace/explorer/useFileNesting";
import { useIconRailSize } from "../../shell/rail/useIconRailSize";
import { type Skin, useSkin } from "../../skins/useSkin";

// How the workspace looks: color scheme, accent color, file-tree treatment, and which tabs the terminal strip carries.
// Each setting re-renders the whole UI live, so most of the app is its own preview; the Explorer gets an inline sample
// since its tree isn't on this page.

const { scheme, set: setScheme, accent, setAccent } = useTheme();
const { textSize, setTextSize } = useTextSize();
const { explorerStyle, explorerStyles } = useExplorerStyle();
const { iconRailSize } = useIconRailSize();
const { fileNesting } = useFileNesting();
// Review-list reading: groupByModule also has a toggle on the Changes panel; largestFirst is set only here.
const { groupByModule } = useChangeGrouping();
const { largestFirst } = useChangeWeight();
// How much of an agent's working shows in transcripts; also flipped from the chat's own readout row.
const { showToolCalls } = useToolCalls();
// showIgnored/hideTests mirror the toolbar's filter; diffOpen has no other home, deciding where a diff opens.
const { showIgnored, toggleShowIgnored, hideTests, toggleHideTests, diffOpen, setDiffOpen } = useLayout();

// Order a reader gives up ground: top, then past imports, then the biggest changed block.
const DIFF_OPEN_OPTIONS = [
    { label: `Top`, value: `top`, title: `The first change in the file, imports and all` },
    { label: `Past imports`, value: `imports`, title: `The first change that isn't an import: nothing above it but the import list` },
    { label: `Biggest change`, value: `biggest`, title: `The block with the most changed lines: earlier changes end up above you` },
] as const satisfies readonly { label: string; value: DiffOpen; title: string }[];

// SegmentedControl labels are capitalized; the values are the raw token strings the composables store.
const cap = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

// A skin rides the Theme row instead of its own control, since two controls could show a light scheme under a dark skin
// with no way back; picking a scheme drops the skin. To remove skins: delete this block and the useSkin import, keep
// light/dark, and wire the row back to scheme/setScheme.
const { skin, setSkin } = useSkin();
type ThemeChoice = "light" | "dark" | Skin;
const themeOptions = [
    { label: `Light`, value: `light` as const },
    { label: `Dark`, value: `dark` as const },
    {
        label: `Sanctum`,
        value: `sanctum` as const,
        title: `The look of intentic.dev: ash stone, a gold rule round every panel, carved and cast plaques, and the site's own type.`,
    },
];
// Icon names the look, not the light level: what the row now chooses.
const THEME_ICON: Record<ThemeChoice, IconName> = { light: `sun`, dark: `moon`, sanctum: `star-fill`, none: `moon` };
const themeChoice = computed<ThemeChoice>(() => (skin.value === `none` ? scheme.value : skin.value));
const setThemeChoice = (value: ThemeChoice): void => {
    // useSkin also flips the color scheme, since the skin assumes a near-black canvas PrimeVue keys off.
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
// Labeled by effect, not percentage, so nobody sets this and the browser's 110% zoom together.
const textSizeOptions = [
    { label: `Compact`, value: `compact` as const },
    { label: `Comfortable`, value: `default` as const, title: `110% — the size the interface was drawn at` },
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
            <Row :icon="THEME_ICON[themeChoice]" title="Theme">
                <template #control
                    ><SegmentedControl :model-value="themeChoice" :options="themeOptions" @update:model-value="setThemeChoice"
                /></template>
            </Row>
            <!-- wide-control lets this wrap to a second line in a narrow pane rather than stretch the row. -->
            <Row icon="palette" title="Colour" wide-control>
                <template #control>
                    <ColorPicker :model-value="accent" class="justify-end" @update:model-value="setAccent" />
                </template>
            </Row>
            <!-- Above the rail row: this one moves the whole workspace, that one moves a column of it. -->
            <Row icon="expand" title="Text size">
                <template #control
                    ><SegmentedControl :model-value="textSize" :options="textSizeOptions" @update:model-value="setTextSize"
                /></template>
            </Row>
            <Row icon="sliders-h" title="Icon rail">
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
            <Row icon="sitemap" title="Explorer">
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
            <Row as="label" icon="eye" title="Show ignored files" description="Show node_modules, build output, and gitignored paths.">
                <template #control>
                    <ToggleSwitch :model-value="showIgnored" @update:model-value="toggleShowIgnored()" />
                </template>
            </Row>
            <Row as="label" icon="filter" title="Hide tests" description="Hide test files and folders in explorer.">
                <template #control>
                    <ToggleSwitch :model-value="hideTests" @update:model-value="toggleHideTests()" />
                </template>
            </Row>
        </RowGroup>

        <!-- How a review reads: its file list and where each diff opens; grouping mirrors the panel's own toggle. -->
        <RowGroup label="Changes">
            <Row as="label" icon="box" title="Group by module" description="Group files by package in review lists.">
                <template #control><ToggleSwitch v-model="groupByModule" /></template>
            </Row>
            <!-- The reorder half of file weighting (changeWeight.ts); the rail beside each row's +/− is always on. -->
            <Row
                as="label"
                icon="sort-desc"
                title="Most added first"
                description="Order review lists by how much each file added, instead of by path, within each package."
            >
                <template #control><ToggleSwitch v-model="largestFirst" /></template>
            </Row>
            <!-- Not as="label" like its neighbors: a label wrapping three buttons would route every click to the first. -->
            <Row icon="forward" title="Where a diff opens">
                <template #control
                    ><SegmentedControl :model-value="diffOpen" :options="DIFF_OPEN_OPTIONS" @update:model-value="setDiffOpen"
                /></template>
            </Row>
        </RowGroup>

        <!-- How much of an agent's working-out shows in transcripts; also flipped from the chat's own readout row. -->
        <RowGroup label="Chat">
            <Row as="label" icon="eye" title="Show tool calls" description="Display individual tool calls in transcript.">
                <template #control><ToggleSwitch v-model="showToolCalls" /></template>
            </Row>
        </RowGroup>

        <!-- Work terminals are hidden by default (evidence, not kept tabs); this toggle is the way back. -->
        <RowGroup label="Terminal">
            <Row as="label" icon="sparkles" title="Work terminals">
                <template #control><ToggleSwitch v-model="showWorkTerminals" /></template>
            </Row>
        </RowGroup>
    </div>
</template>
