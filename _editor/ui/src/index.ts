export { clipboardOf } from "./clipboard.js";
export { cmp } from "./cmp.js";
export { default as AnchoredOverlay } from "./components/AnchoredOverlay.vue";
export { default as Avatar } from "./components/Avatar.vue";
export { type Cross, placeAnchored, type Placement, type Side } from "./composables/anchorPlacement.js";
export { default as BarChart } from "./components/BarChart.vue";
export { type BarItem } from "./components/barChart.js";
export { default as BottomSheet } from "./components/BottomSheet.vue";
// <Avatar> for things rather than people: the logo → glyph → initials ladder every surface that LISTS
// something needs, and that four call sites had each got a different amount of right.
export { default as BrandMark } from "./components/BrandMark.vue";
export { default as Card } from "./components/Card.vue";
// The two halves of a changed-file row, shipped together because they are always drawn together: git's status
// letter in its fixed-width cell, and the +/- line-count badge beside it. Six surfaces had each written both by
// hand, and the seventh caller was an extension — which could reach none of the six.
export { default as ChangeStatusMark } from "./components/ChangeStatusMark.vue";
export { type ChangeStatus } from "./components/changeStatus.js";
export { default as DiffStat } from "./components/DiffStat.vue";
export { default as Code } from "./components/Code.vue";
// The writing half of <Code> — the same colours, with a caret in them. Ships beside it for the reason <Row>
// ships beside <RowGroup>: the read-only block on its own is what made every surface that also had to EDIT
// the file fall back to a bare grey <textarea> next to it.
export { default as CodeField } from "./components/CodeField.vue";
export { default as ConfirmDialog } from "./components/ConfirmDialog.vue";
export { default as ContextMenu } from "./components/ContextMenu.vue";
export { default as CopyButton } from "./components/CopyButton.vue";
export { type CountItem, default as CountBar } from "./components/CountBar.vue";
export { default as DagEditor } from "./components/DagEditor.vue";
export { default as DagGraph } from "./components/DagGraph.vue";
// Types only. The DAG layout FUNCTIONS ship as `@intentic/ui/dag` for the same reason the markdown engine
// does: they are plain TypeScript, and a unit test should not have to boot this barrel's component graph (and a
// DOM with it) to call one. See the note above renderMarkdown's subpath.
// `layoutDag` ships beside the types because a caller sometimes needs to know WHERE the graph put things —
// the chat panel groups a run's steps into the columns the reader can see, and computing that from the
// dependency depth instead would be a second opinion about a layout dagre has already decided.
export { type DagEdge, type DagNode, layoutDag } from "./components/dagLayout.js";
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
// One computer's desktop-sync detail — folders, localhost ports, watcher liveness. The BODY only: the desktop
// app and the web's Computers tab frame it differently and state exactly the same facts inside.
export { default as MachineDetail } from "./components/MachineDetail.vue";
export {
    type MachineFolderRow,
    type MachinePortRow,
    type MachineSandboxGroup,
    type MachineSandboxRow,
    type MachineWatcherState,
} from "./components/machineDetail.js";
export { default as Markdown } from "./components/Markdown.vue";
export { default as MarkdownFigure } from "./components/MarkdownFigure.vue";
// A mermaid diagram, drawn from the fence body by mermaid itself and dressed in the app's tokens. Exported
// because a view holding a diagram outside prose (a stored architecture note, a generated report) should not
// have to wrap it in a markdown document to get one.
export { default as MermaidDiagram } from "./components/MermaidDiagram.vue";
// The index column: a filter, pinned rows, grouped selectable rows, a footnote. Owns the chrome; the row stays
// the caller's, because a rail's rows differ for good reasons and its scrollbar never did.
export { default as NavRail } from "./components/NavRail.vue";
export { type NavGroup } from "./components/navRail.js";
// How the app says something went wrong: a sentence it wrote, the raw cause underneath, at most one way out.
// The stack is what a view with more than one thing wrong renders — it ranks by severity and collapses repeats,
// so the reading order stops being an accident of where the boxes sit in the template.
export { default as Notice } from "./components/Notice.vue";
export { default as NoticeStack } from "./components/NoticeStack.vue";
export { type NoticeAction, type NoticeModel, type NoticeTone } from "./components/notice.js";
export { default as Page } from "./components/Page.vue";
// The button that goes in <PageHeader #actions>, and the only thing that should — the named recipe that keeps
// PrimeVue Button's variant matrix out of the one slot every view fills.
export { default as PageAction } from "./components/PageAction.vue";
export { default as PageHeader } from "./components/PageHeader.vue";
// A bordered surface: its own header, its own interrupting strips, one scrolling body. Header and frame are one
// component because every caller of the header wrapped it in the frame — and the min-h-0/overflow-hidden scroll
// contract it owns is the failure three views had each rediscovered, one of them incorrectly.
export { default as Panel } from "./components/Panel.vue";
export { default as Picker } from "./components/Picker.vue";
export { type PickerGroup, type PickerOption, type PickerOptions } from "./components/picker.js";
export { default as ProgressRing } from "./components/ProgressRing.vue";
// The writing field — `cmp.input()`'s counterpart for text read in sentences. Borderless, and as tall as what
// has been typed into it.
export { default as ProseField } from "./components/ProseField.vue";
export { default as PullToRefresh } from "./components/PullToRefresh.vue";
// The drag strip between two panes. Four screens had written it by hand before this existed, and the fifth
// caller was an extension, which could not have reached any of the four.
export { default as ResizeSeam } from "./components/ResizeSeam.vue";
// The app's standard touch swap — anchored panel on desktop, bottom sheet on a phone — behind one open flag.
// <Picker> had encapsulated it internally without exposing it, so five other menus wrote the pair out by hand.
export { default as ResponsiveOverlay } from "./components/ResponsiveOverlay.vue";
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
// Whether that screen has folded its index above its body — what a rail asks so its own compact form arrives at
// the same width the shell's does.
export { useCompact } from "./components/splitView.js";
export { default as StatRow } from "./components/StatRow.vue";
export { default as StatusBadge, type StatusVariant } from "./components/StatusBadge.vue";
export { default as StepSection } from "./components/StepSection.vue";
export { Theme } from "./styles/theme.js";
export { installUi } from "./plugin.js";
// The markdown ENGINE is not re-exported here — it ships as `@intentic/ui/markdown` so plain .ts modules
// and unit tests can use it without dragging in this barrel's component graph. See markdown/index.ts.
export { vTw } from "./composables/tw.js";
export { type CodeToken, useHighlighter } from "./composables/useHighlighter.js";
export {
    formatBytes,
    formatDate,
    formatDateTime,
    formatDayMonth,
    formatTime,
    formatTimestamp,
    formatTokens,
    formatWeekdayTime,
    initialsOf,
    timeAgo,
} from "./format.js";
// The app's one "how far back" vocabulary — the 1h/24h/7d/All pills, the cutoff they mean, and the words a
// caller says about them. Activity and Logs had each written all three.
export { sinceOf, TIME_WINDOWS, type TimeWindow, timeWindowWords, withinWindow } from "./timeWindow.js";
// Path splitting is NOT re-exported here — it ships as `@intentic/ui/path`, for the same reason the
// markdown engine does: `fileType.ts` and `explorerPaste.ts` are unit-tested plain TypeScript, and neither
// should have to boot this barrel's component graph (and a DOM with it) to split a string on "/".
//
// The Shiki grammar table is NOT re-exported here either, and ships as `@intentic/ui/langs`. Same reason,
// same caller: `fileType.ts` maps every extension the app knows onto a `ShikiLang`, and that is the module the
// mapping has to be checked against.
//
// `seriesColor` above is the one export that ships BOTH ways, and deliberately. A Vue caller reaches it here
// (the documentation sidebar paints an authored accent, and it has already booted this graph to render at
// all); a plain-TypeScript caller reaches the same function at `@intentic/ui/series`, because the
// usage/savings projections are unit-tested in a node environment and this barrel pulls Picker.vue →
// useDevice → `window` in behind it. One implementation, two doors, and the subpath is the one that must
// stay open — a test that has to stub matchMedia to compute a colour is a test about the wrong thing.
// The name vocabulary and the set switcher. Asking whether an OPEN string (a manifest's `icon`, an
// `Activation.icon`) is one of these names is `isIconName`, and it lives at `@intentic/ui/icons` rather than
// here: its callers are pure-TypeScript — a renderer's fallback ladder, and the tests that read our own
// extensions' manifests off disk — and reaching it through this barrel boots Picker.vue and wants a DOM.
// Renderers should keep using <Icon name="…">.
export { type IconName } from "./icons/iconSets.js";
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
/* Is THIS ELEMENT too narrow for the layout it wants — the pane-shaped question, and almost always the one a
 * view means. `useDevice` answers about the screen, and a view that renders between the rail and a draggable
 * chat panel is never as wide as the screen. */
export { useNarrow } from "./composables/useNarrow.js";
export { useListNavigation } from "./composables/useListNavigation.js";
/* The wall clock and the mutation-report shape moved here from the web app when the drafts queue became an
 * extension: both are exactly what every view with a live readout or a user-facing mutation hand-rolls, and the
 * app's four independent `now` intervals were the original argument for the first one. */
export { useNow } from "./composables/useNow.js";
export { errorMessage, noticeFrom, noticeOf, useAsyncAction } from "./composables/useAsyncAction.js";
export { type ColorScheme, useTheme } from "./composables/useTheme.js";
// The one colour the app wears, as a control. The maths behind it stays inside the kit (themeColor.ts turns
// the picked colour into the ramps every surface, border and link resolves through) — a caller only ever
// needs the picker and `useTheme().accent`.
export { default as ColorPicker } from "./components/ColorPicker.vue";
export { type TextSize, useTextSize } from "./composables/useTextSize.js";
