<script setup lang="ts">
import {
    ColorPicker,
    Picker,
    Row,
    RowGroup,
    SegmentedControl,
    useExplorerStyle,
    useTextSize,
    useTheme,
    explorerTreatment,
    type IconName,
} from "@intentic/ui";
import { activeLocale, type Locale, LOCALE_CODES, LOCALES, setLocale, useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useToolCalls } from "../chat/tools/useToolCalls";
import { showWorkTerminals } from "../terminal/useWorkTerminals";
import { type DiffOpen, useLayout } from "../../shell/window/useLayout";
import { useChangeGrouping } from "../workspace/changes/useChangeGrouping";
import { useChangeWeight } from "../workspace/changes/changeWeight";
import { useFileNesting } from "../workspace/explorer/useFileNesting";
import { useDesk } from "../workspace/desk/useDesk";
import { useIconRailSize } from "../../shell/rail/useIconRailSize";
import { useSkin } from "../../skins/useSkin";
import { THEME_ROW, type ThemeRow, themeRowLook, themeRowValue } from "./themeRow";
import { type Audience, useAudience } from "../../app/useAudience";

// How the workspace looks: color scheme, accent color, file-tree treatment, and which tabs the terminal strip carries.
// Each setting re-renders the whole UI live, so most of the app is its own preview; the Explorer gets an inline sample
// since its tree isn't on this page.

const { choice: schemeChoice, set: setScheme, accent, setAccent } = useTheme();
const { textSize, setTextSize } = useTextSize();
const { explorerStyle, explorerStyles } = useExplorerStyle();
const { iconRailSize } = useIconRailSize();
const { fileNesting } = useFileNesting();
// The main pane's "nothing open" surface: the open folder as tiles, or the plain drop target.
const { desk } = useDesk();
// Review-list reading: groupByModule also has a toggle on the Changes panel; largestFirst is set only here.
const { groupByModule } = useChangeGrouping();
const { largestFirst } = useChangeWeight();
// How much of an agent's working shows in transcripts; also flipped from the chat's own readout row.
const { showToolCalls } = useToolCalls();
// showIgnored/hideTests/hideTechnical mirror the toolbar's filter; diffOpen has no other home, deciding where a diff
// opens.
const { showIgnored, toggleShowIgnored, hideTests, toggleHideTests, hideTechnical, toggleHideTechnical, diffOpen, setDiffOpen } = useLayout();

// EVERY OPTION LIST ON THIS PAGE IS A `computed`, and that is not style. `t` reads the active language from a ref, so
// a list built once at setup holds the words it was born with and never hears the language change under it.
const t = useT();

// Who the screens are written for: the same workspace with git's words or plain ones, and a different home tile.
const { audience, setAudience } = useAudience();
const audienceOptions = computed(
    () =>
        [
            { label: t(`settings.appearance.work.developer`), value: `developer`, title: t(`settings.appearance.work.developerHint`) },
            { label: t(`settings.appearance.work.maker`), value: `maker`, title: t(`settings.appearance.work.makerHint`) },
        ] satisfies readonly { label: string; value: Audience; title: string }[],
);

// Order a reader gives up ground: top, then past imports, then the biggest changed block.
const diffOpenOptions = computed(
    () =>
        [
            { label: t(`settings.appearance.changes.diffOpenTop`), value: `top`, title: t(`settings.appearance.changes.diffOpenTopHint`) },
            {
                label: t(`settings.appearance.changes.diffOpenImports`),
                value: `imports`,
                title: t(`settings.appearance.changes.diffOpenImportsHint`),
            },
            {
                label: t(`settings.appearance.changes.diffOpenBiggest`),
                value: `biggest`,
                title: t(`settings.appearance.changes.diffOpenBiggestHint`),
            },
        ] satisfies readonly { label: string; value: DiffOpen; title: string }[],
);

// A skin rides the Theme row instead of its own control, since two controls could show a light scheme under a dark skin
// with no way back; the mapping between the row and the two preferences is themeRow.ts. To remove skins: delete this
// block and the useSkin import, keep system/light/dark, and wire the row back to schemeChoice/setScheme.
const { skin, choice: skinChoice, setSkin } = useSkin();
// Only two of the four rows explain themselves; the key exists for all four so the lookup below stays a plain one.
const THEME_TITLED: ReadonlySet<ThemeRow> = new Set([`system`, `sanctum`]);
const themeOptions = computed(() =>
    THEME_ROW.map((value) => ({
        label: t(`settings.appearance.theme.${value}`),
        value,
        ...(THEME_TITLED.has(value) ? { title: t(`settings.appearance.theme.${value === `system` ? `systemHint` : `sanctumHint`}`) } : {}),
    })),
);
// Icon names the look, not the light level: what the row now chooses.
const THEME_ICON: Record<ThemeRow, IconName> = { system: `desktop`, light: `sun`, dark: `moon`, sanctum: `star-fill` };
const themeChoice = computed<ThemeRow>(() => themeRowValue(schemeChoice.value, skinChoice.value, skin.value));
const setThemeChoice = (value: ThemeRow): void => {
    const look = themeRowLook(value);
    // The skin goes first: pinning sanctum drags the scheme dark with it, and the line below then says so outright.
    setSkin(look.skin);
    setScheme(look.scheme);
};
const explorerOptions = computed(() => explorerStyles.map((value) => ({ label: t(`settings.appearance.explorer.${value}`), value })));
const iconRailOptions = computed(() => [
    { label: t(`settings.appearance.look.iconRailCompact`), value: `compact` as const },
    { label: t(`settings.appearance.look.iconRailComfortable`), value: `comfortable` as const },
]);
// Labeled by effect, not percentage, so nobody sets this and the browser's 110% zoom together.
const textSizeOptions = computed(() => [
    { label: t(`settings.appearance.look.textSizeCompact`), value: `compact` as const },
    {
        label: t(`settings.appearance.look.textSizeComfortable`),
        value: `default` as const,
        title: t(`settings.appearance.look.textSizeComfortableHint`),
    },
    { label: t(`settings.appearance.look.textSizeLarge`), value: `large` as const },
]);

// The one list on this page that is NOT translated: a reader hunting for their own language finds it faster written
// in itself than in a language they cannot read. `activeLocale` rather than the choice, so the control shows what is
// actually on screen — the two differ only for the one chunk fetch that `setLocale` awaits.
const languageOptions = LOCALE_CODES.map((code) => ({ value: code, label: LOCALES[code].endonym }));
const pickLanguage = (locale: Locale | undefined): void => {
    if (locale !== undefined) {
        void setLocale(locale);
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
    <div class="flex flex-col gap-6">
        <!-- Who the words are for; first, since it decides what the rest of the app is called. -->
        <RowGroup :label="t(`settings.appearance.work.group`)">
            <Row icon="user" :title="t(`settings.appearance.work.title`)" :description="t(`settings.appearance.work.hint`)">
                <template #control
                    ><SegmentedControl :model-value="audience" :options="audienceOptions" @update:model-value="setAudience"
                /></template>
            </Row>
        </RowGroup>

        <!-- Look: whole-workspace appearance choices. -->
        <RowGroup :label="t(`settings.appearance.look.group`)">
            <!-- First in the group: it decides what every other row on this page is written in. -->
            <Row icon="globe" :title="t(`settings.appearance.look.language`)" :description="t(`settings.appearance.look.languageHint`)">
                <template #control>
                    <Picker
                        :model-value="activeLocale"
                        :options="languageOptions"
                        :aria-label="t(`settings.appearance.look.language`)"
                        @update:model-value="pickLanguage"
                    />
                </template>
            </Row>
            <Row :icon="THEME_ICON[themeChoice]" :title="t(`settings.appearance.look.theme`)">
                <template #control
                    ><SegmentedControl :model-value="themeChoice" :options="themeOptions" @update:model-value="setThemeChoice"
                /></template>
            </Row>
            <!-- wide-control lets this wrap to a second line in a narrow pane rather than stretch the row. -->
            <Row icon="palette" :title="t(`settings.appearance.look.colour`)" wide-control>
                <template #control>
                    <ColorPicker :model-value="accent" class="justify-end" @update:model-value="setAccent" />
                </template>
            </Row>
            <!-- Above the rail row: this one moves the whole workspace, that one moves a column of it. -->
            <Row icon="expand" :title="t(`settings.appearance.look.textSize`)">
                <template #control
                    ><SegmentedControl :model-value="textSize" :options="textSizeOptions" @update:model-value="setTextSize"
                /></template>
            </Row>
            <Row icon="sliders-h" :title="t(`settings.appearance.look.iconRail`)">
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
        <RowGroup :label="t(`settings.appearance.explorer.group`)">
            <Row icon="sitemap" :title="t(`settings.appearance.explorer.title`)">
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
            <Row
                as="label"
                icon="folder-open"
                :title="t(`settings.appearance.explorer.fileNesting`)"
                :description="t(`settings.appearance.explorer.fileNestingHint`)"
            >
                <template #control><ToggleSwitch v-model="fileNesting" /></template>
            </Row>
            <Row
                as="label"
                icon="eye"
                :title="t(`settings.appearance.explorer.showIgnored`)"
                :description="t(`settings.appearance.explorer.showIgnoredHint`)"
            >
                <template #control>
                    <ToggleSwitch :model-value="showIgnored" @update:model-value="toggleShowIgnored()" />
                </template>
            </Row>
            <Row
                as="label"
                icon="filter"
                :title="t(`settings.appearance.explorer.hideTests`)"
                :description="t(`settings.appearance.explorer.hideTestsHint`)"
            >
                <template #control>
                    <ToggleSwitch :model-value="hideTests" @update:model-value="toggleHideTests()" />
                </template>
            </Row>
            <Row
                as="label"
                icon="wrench"
                :title="t(`settings.appearance.explorer.hideTechnical`)"
                :description="t(`settings.appearance.explorer.hideTechnicalHint`)"
            >
                <template #control>
                    <ToggleSwitch :model-value="hideTechnical" @update:model-value="toggleHideTechnical()" />
                </template>
            </Row>
        </RowGroup>

        <!-- What the main pane shows between files. -->
        <RowGroup :label="t(`settings.appearance.desk.group`)">
            <Row as="label" icon="th-large" :title="t(`settings.appearance.desk.title`)" :description="t(`settings.appearance.desk.hint`)">
                <template #control><ToggleSwitch v-model="desk" /></template>
            </Row>
        </RowGroup>

        <!-- How a review reads: its file list and where each diff opens; grouping mirrors the panel's own toggle. -->
        <RowGroup :label="t(`settings.appearance.changes.group`)">
            <Row
                as="label"
                icon="box"
                :title="t(`settings.appearance.changes.groupByModule`)"
                :description="t(`settings.appearance.changes.groupByModuleHint`)"
            >
                <template #control><ToggleSwitch v-model="groupByModule" /></template>
            </Row>
            <!-- The reorder half of file weighting (changeWeight.ts); the rail beside each row's +/− is always on. -->
            <Row
                as="label"
                icon="sort-desc"
                :title="t(`settings.appearance.changes.largestFirst`)"
                :description="t(`settings.appearance.changes.largestFirstHint`)"
            >
                <template #control><ToggleSwitch v-model="largestFirst" /></template>
            </Row>
            <!-- Not as="label" like its neighbors: a label wrapping three buttons would route every click to the first. -->
            <Row icon="forward" :title="t(`settings.appearance.changes.diffOpen`)">
                <template #control
                    ><SegmentedControl :model-value="diffOpen" :options="diffOpenOptions" @update:model-value="setDiffOpen"
                /></template>
            </Row>
        </RowGroup>

        <!-- How much of an agent's working-out shows in transcripts; also flipped from the chat's own readout row. -->
        <RowGroup :label="t(`settings.appearance.chat.group`)">
            <Row
                as="label"
                icon="eye"
                :title="t(`settings.appearance.chat.showToolCalls`)"
                :description="t(`settings.appearance.chat.showToolCallsHint`)"
            >
                <template #control><ToggleSwitch v-model="showToolCalls" /></template>
            </Row>
        </RowGroup>

        <!-- Work terminals are hidden by default (evidence, not kept tabs); this toggle is the way back. -->
        <RowGroup :label="t(`settings.appearance.terminal.group`)">
            <Row as="label" icon="sparkles" :title="t(`settings.appearance.terminal.workTerminals`)">
                <template #control><ToggleSwitch v-model="showWorkTerminals" /></template>
            </Row>
        </RowGroup>
    </div>
</template>
