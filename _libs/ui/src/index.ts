export { clipboardOf } from "./clipboard.js";
export { cmp } from "./cmp.js";
export { default as AnchoredOverlay } from "./components/AnchoredOverlay.vue";
export { default as Avatar } from "./components/Avatar.vue";
export { type Cross, placeAnchored, type Placement, type Side } from "./composables/anchorPlacement.js";
export { default as BarChart } from "./components/BarChart.vue";
export { type BarItem } from "./components/barChart.js";
export { default as BottomSheet } from "./components/BottomSheet.vue";
export { default as Card } from "./components/Card.vue";
export { default as Code } from "./components/Code.vue";
export { default as ConfirmDialog } from "./components/ConfirmDialog.vue";
export { default as ContextMenu } from "./components/ContextMenu.vue";
export { default as CopyButton } from "./components/CopyButton.vue";
export { type CountItem, default as CountBar } from "./components/CountBar.vue";
export { default as DagGraph } from "./components/DagGraph.vue";
// Types only. The DAG layout FUNCTIONS ship as `@intentic-app/ui/dag` for the same reason the markdown engine
// does: they are plain TypeScript, and a unit test should not have to boot this barrel's component graph (and a
// DOM with it) to call one. See the note above renderMarkdown's subpath.
export { type DagEdge, type DagNode } from "./components/dagLayout.js";
// The instrument above a list — free text, the controls that narrow it, and any bare action. In the kit rather
// than in any one view because six views had written the row by hand and no two of them agreed.
export { default as FilterBar } from "./components/FilterBar.vue";
export { default as Icon } from "./components/Icon.vue";
// THE surface that shows a picture — the workspace file viewer's images (through the viewers extension), the
// SVG preview, and both sides of a binary diff. In the kit rather than in either caller so zoom, pan and the
// transparency checkerboard behave identically wherever an image appears.
export { default as ImageView } from "./components/ImageView.vue";
export { isRenderableImage } from "./components/imageView.js";
export { default as InfoDialog } from "./components/InfoDialog.vue";
export { default as InfoHint } from "./components/InfoHint.vue";
export { default as InfoTable } from "./components/InfoTable.vue";
export { default as Markdown } from "./components/Markdown.vue";
export { default as MarkdownFigure } from "./components/MarkdownFigure.vue";
// The index column: a filter, pinned rows, grouped selectable rows, a footnote. Owns the chrome; the row stays
// the caller's, because a rail's rows differ for good reasons and its scrollbar never did.
export { default as NavRail } from "./components/NavRail.vue";
export { type NavGroup } from "./components/navRail.js";
export { default as Page } from "./components/Page.vue";
export { default as PageHeader } from "./components/PageHeader.vue";
// A bordered surface: its own header, its own interrupting strips, one scrolling body. Header and frame are one
// component because every caller of the header wrapped it in the frame — and the min-h-0/overflow-hidden scroll
// contract it owns is the failure three views had each rediscovered, one of them incorrectly.
export { default as Panel } from "./components/Panel.vue";
export { default as Picker } from "./components/Picker.vue";
export { type PickerGroup, type PickerOption, type PickerOptions } from "./components/picker.js";
export { default as ProgressRing } from "./components/ProgressRing.vue";
export { default as PullToRefresh } from "./components/PullToRefresh.vue";
export { default as Row } from "./components/Row.vue";
export { default as RowGroup } from "./components/RowGroup.vue";
export { default as SearchBar } from "./components/SearchBar.vue";
export { default as Segmented } from "./components/Segmented.vue";
// The accent → palette-slot resolver, exported for the same reason the figure types are: a view that holds
// authored accents (a documentation map's components, say) has to paint them the way a figure would.
export { seriesColor } from "./components/seriesAccent.js";
// The index-and-body screen — five views were four implementations of it, and the one that had solved it
// (HubLayout) lived in the web app where no extension could reach it.
export { default as SplitView } from "./components/SplitView.vue";
export { default as StatRow } from "./components/StatRow.vue";
export { default as StatusBadge, type StatusVariant } from "./components/StatusBadge.vue";
export { default as StepSection } from "./components/StepSection.vue";
export { Theme } from "./styles/theme.js";
export { installUi } from "./plugin.js";
// The markdown ENGINE is not re-exported here — it ships as `@intentic-app/ui/markdown` so plain .ts modules
// and unit tests can use it without dragging in this barrel's component graph. See markdown/index.ts.
export { vTw } from "./composables/tw.js";
export { type CodeToken, useHighlighter } from "./composables/useHighlighter.js";
export { formatBytes, formatTokens, timeAgo } from "./format.js";
// The app's one "how far back" vocabulary — the 1h/24h/7d/All pills, the cutoff they mean, and the words a
// caller says about them. Activity and Logs had each written all three.
export { sinceOf, TIME_WINDOWS, type TimeWindow, timeWindowWords, withinWindow } from "./timeWindow.js";
// Path splitting is NOT re-exported here — it ships as `@intentic-app/ui/path`, for the same reason the
// markdown engine does: `fileType.ts` and `explorerPaste.ts` are unit-tested plain TypeScript, and neither
// should have to boot this barrel's component graph (and a DOM with it) to split a string on "/".
//
// The Shiki grammar table is NOT re-exported here either, and ships as `@intentic-app/ui/langs`. Same reason,
// same caller: `fileType.ts` maps every extension the app knows onto a `ShikiLang`, and that is the module the
// mapping has to be checked against.
//
// `seriesColor` above is the one export that ships BOTH ways, and deliberately. A Vue caller reaches it here
// (the documentation sidebar paints an authored accent, and it has already booted this graph to render at
// all); a plain-TypeScript caller reaches the same function at `@intentic-app/ui/series`, because the
// usage/savings projections are unit-tested in a node environment and this barrel pulls Picker.vue →
// useDevice → `window` in behind it. One implementation, two doors, and the subpath is the one that must
// stay open — a test that has to stub matchMedia to compute a colour is a test about the wrong thing.
// ICON_SETS is exported for its KEYS, not its values: `Activation.icon` in the public extension API is an open
// string, so the only way to check a first-party extension actually names a real icon is to compare against the
// vocabulary at runtime (see builtins.test.ts). Renderers should keep using <Icon name="…">.
export { ICON_SETS, type IconName, type IconSet, iconSets } from "./icons/iconSets.js";
export { type ExplorerStyle, explorerStyles } from "./icons/explorerStyle.js";
export {
    categoryForEntry,
    explorerColorClass,
    type ExplorerTreatment,
    explorerTreatment,
    type FileCategory,
    iconForEntry,
} from "./icons/fileIcon.js";
export { useExplorerStyle } from "./composables/useExplorerStyle.js";
export { commandLang, type CommandOs, OS_OPTIONS, useOsPreference } from "./composables/useOsPreference.js";
export { type Device, useDevice } from "./composables/useDevice.js";
export { useListNavigation } from "./composables/useListNavigation.js";
export { useIconSet } from "./composables/useIconSet.js";
export { type ColorScheme, useTheme } from "./composables/useTheme.js";
