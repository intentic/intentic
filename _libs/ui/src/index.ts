export { cmp } from "./cmp.js";
export { default as AnchoredOverlay } from "./components/AnchoredOverlay.vue";
export { type Cross, placeAnchored, type Side } from "./composables/anchorPlacement.js";
export { default as BarChart } from "./components/BarChart.vue";
export { default as BottomSheet } from "./components/BottomSheet.vue";
export { default as Card } from "./components/Card.vue";
export { default as Code } from "./components/Code.vue";
export { default as CopyButton } from "./components/CopyButton.vue";
export { default as DagGraph } from "./components/DagGraph.vue";
// Types only. The DAG layout FUNCTIONS ship as `@intentic-app/ui/dag` for the same reason the markdown engine
// does: they are plain TypeScript, and a unit test should not have to boot this barrel's component graph (and a
// DOM with it) to call one. See the note above renderMarkdown's subpath.
export { type DagEdge, type DagNode } from "./components/dagLayout.js";
export { default as Icon } from "./components/Icon.vue";
export { default as InfoDialog } from "./components/InfoDialog.vue";
export { default as InfoHint } from "./components/InfoHint.vue";
export { default as InfoTable } from "./components/InfoTable.vue";
export { default as Markdown } from "./components/Markdown.vue";
export { default as MarkdownFigure } from "./components/MarkdownFigure.vue";
export { default as Page } from "./components/Page.vue";
export { default as PageHeader } from "./components/PageHeader.vue";
export { default as Picker } from "./components/Picker.vue";
export { type PickerGroup, type PickerOption, type PickerOptions } from "./components/picker.js";
export { default as ProgressRing } from "./components/ProgressRing.vue";
export { default as PullToRefresh } from "./components/PullToRefresh.vue";
export { default as Row } from "./components/Row.vue";
export { default as RowGroup } from "./components/RowGroup.vue";
export { default as Segmented } from "./components/Segmented.vue";
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
export { type CommandOs, useOsPreference } from "./composables/useOsPreference.js";
export { type Device, useDevice } from "./composables/useDevice.js";
export { useListNavigation } from "./composables/useListNavigation.js";
export { useIconSet } from "./composables/useIconSet.js";
export { type ColorScheme, useTheme } from "./composables/useTheme.js";
