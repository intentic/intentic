export { clipboardOf } from "./lib/clipboard.js";
// "The browser is opening this one itself, stand down" — the one test every navigational row, tile and menu
// item in the app runs before it also does app work on a click, and the pair of anchor attributes that applies
// it for the surfaces with no router to reach. See lib/link.ts.
export { appLink, browserOwnsClick } from "./lib/link.js";
// Waiting on a freshly-minted preview hostname, and the tab-opening dance around a forwarded port. Three
// surfaces had written the same loop, one of them an extension that could reach neither of the others.
export {
    type ForwardedPortTab,
    openForwardedPort,
    parseLoopbackLink,
    type ProbeOptions,
    type ProbeOutcome,
    probeUntilReachable,
} from "./lib/portPreview.js";
export { ui } from "./lib/ui.js";
export { default as AgentRunButton } from "./components/AgentRunButton.vue";
export { type AgentRunChoice, type AgentRunPicker, type ModelPicking, useAgentRunPick } from "./composables/useAgentRunPick.js";
export { default as AnchoredOverlay } from "./components/AnchoredOverlay.vue";
export { default as Avatar } from "./components/Avatar.vue";
export { type Cross, placeAnchored, type Placement, type Side } from "./lib/anchorPlacement.js";
export { default as BarChart } from "./components/BarChart.vue";
export { type BarItem } from "./components/barChart.js";
export { default as BottomSheet } from "./components/BottomSheet.vue";
// <Avatar> for things rather than people: the logo → glyph → initials ladder every surface that LISTS
// something needs, and that four call sites had each got a different amount of right.
export { default as BrandMark } from "./components/BrandMark.vue";
export { default as Card } from "./components/Card.vue";
// The two halves of a changed-file row, shipped together because they are always drawn together: git's status
// letter in its fixed-width cell, and the +/- line-count badge beside it. Six surfaces had each written both by
// hand, and the seventh caller was an extension, which could reach none of the six.
export { default as ChangeStatusMark } from "./components/ChangeStatusMark.vue";
export { type ChangeStatus } from "./components/changeStatus.js";
export { default as DiffStat } from "./components/DiffStat.vue";
export { default as Code } from "./components/Code.vue";
// The writing half of <Code>, the same colours, with a caret in them. Ships beside it for the reason <Row>
// ships beside <RowGroup>: the read-only block on its own is what made every surface that also had to EDIT
// the file fall back to a bare grey <textarea> next to it.
export { default as CodeField } from "./components/CodeField.vue";
export { default as ConfirmDialog } from "./components/ConfirmDialog.vue";
export { default as ContextMenu } from "./components/ContextMenu.vue";
export { default as CopyButton } from "./components/CopyButton.vue";
export { type TallyItem, default as StatusTally } from "./components/StatusTally.vue";
export { default as DagEditor } from "./components/DagEditor.vue";
export { default as DagGraph } from "./components/DagGraph.vue";
// Types only. The DAG layout FUNCTIONS ship as `@intentic/ui/dag` for the same reason the markdown engine
// does: they are plain TypeScript, and a unit test should not have to boot this barrel's component graph (and a
// DOM with it) to call one. See the note above renderMarkdown's subpath.
// `layoutDag` ships beside the types because a caller sometimes needs to know WHERE the graph put things,
// the chat panel groups a run's steps into the columns the reader can see, and computing that from the
// dependency depth instead would be a second opinion about a layout dagre has already decided.
export { type DagEdge, type DagNode, layoutDag } from "./components/dagLayout.js";
// The instrument above a list, free text, the controls that narrow it, and any bare action. In the kit rather
// than in any one view because six views had written the row by hand and no two of them agreed.
export { default as FilterBar } from "./components/FilterBar.vue";
export { default as Icon } from "./components/Icon.vue";
// THE surface that shows a picture, the workspace file viewer's images (through the viewers extension), the
// SVG preview, and both sides of a binary diff. In the kit rather than in either caller so zoom, pan and the
// transparency checkerboard behave identically wherever an image appears.
export { default as ImageView } from "./components/ImageView.vue";
export { isRenderableImage } from "./components/imageView.js";
export { default as InfoDialog } from "./components/InfoDialog.vue";
export { default as InfoHint } from "./components/InfoHint.vue";
export { default as InfoTable } from "./components/InfoTable.vue";
// One computer's desktop-sync detail, folders, localhost ports, watcher liveness. The BODY only: the desktop
// app and the web's Computers tab frame it differently and state exactly the same facts inside.
export { default as MachineDetail } from "./components/MachineDetail.vue";
// The pane under a working row: the machine's own output, verbatim. Shared for the same reason the row above
// it is, both apps drive the same containers and had grown their own.
export { default as MachineRunLog } from "./components/MachineRunLog.vue";
export {
    type GroupSummary,
    groupNeedsAttention,
    groupSummary,
    type MachineFolderRow,
    type MachinePortRow,
    type MachineSandboxGroup,
    type MachineSandboxRow,
    type MachineWatcherState,
    // The same grouping the view draws, for a caller that has to COUNT what it is about to draw, the
    // Computers tab's folded machine line says how many sandboxes are under it and how many want attention.
    sandboxGroups,
} from "./components/machineDetail.js";
// The verb row on one sandbox's line, which buttons exist, their order, their words, and which one is red.
// Here because the desktop manager and the web Computers tab render the same row and had drifted apart.
export { default as SandboxVerbs } from "./components/SandboxVerbs.vue";
export { DESTRUCTIVE_VERB, menuVerbs, primaryVerb, type SandboxVerb, sandboxVerbPrompt, VERB_LABEL } from "./components/sandboxVerbs.js";
export { default as Markdown } from "./components/Markdown.vue";
export { default as MarkdownFigure } from "./components/MarkdownFigure.vue";
// A mermaid diagram, drawn from the fence body by mermaid itself and dressed in the app's tokens. Exported
// because a view holding a diagram outside prose (a stored architecture note, a generated report) should not
// have to wrap it in a markdown document to get one.
export { default as MermaidDiagram } from "./components/MermaidDiagram.vue";
// THE centred box, and the only thing that should reach for PrimeVue's Dialog. Seventeen dialogs had each
// typed their own width into a style attribute, thirteen different ones, and exactly one of the seventeen
// carried the viewport clamp that stops a modal running off the side of a phone. The width is a named size
// here and the clamp is not the caller's to remember. <ConfirmDialog> and <InfoDialog> are built on it.
export { default as Modal } from "./components/Modal.vue";
// The index column: a filter, pinned rows, grouped selectable rows, a footnote. Owns the chrome; the row stays
// the caller's, because a rail's rows differ for good reasons and its scrollbar never did.
export { default as NavRail } from "./components/NavRail.vue";
export { type NavGroup } from "./components/navRail.js";
// One markdown note, read and curated: the action cluster, the delete confirmation, the error strip, and the
// one surface a file is both read and written on. Two extensions had each built the frame around <ScrollFrame>;
// `useNoteDraft` is the lifecycle underneath it, which they had each built too.
export { default as NoteEditor } from "./components/NoteEditor.vue";
export { type NoteDraft, type NoteDraftOptions, useNoteDraft } from "./composables/useNoteDraft.js";
// How the app says something went wrong: a sentence it wrote, the raw cause underneath, at most one way out.
// The stack is what a view with more than one thing wrong renders, it ranks by severity and collapses repeats,
// so the reading order stops being an accident of where the boxes sit in the template.
export { default as Notice } from "./components/Notice.vue";
export { default as NoticeStack } from "./components/NoticeStack.vue";
export { type NoticeAction, type NoticeModel, type NoticeTone } from "./components/notice.js";
export { default as Page } from "./components/Page.vue";
// The button that goes in <PageHeader #actions>, and the only thing that should, the named recipe that keeps
// PrimeVue Button's variant matrix out of the one slot every view fills.
export { default as PageAction } from "./components/PageAction.vue";
export { default as PageHeader } from "./components/PageHeader.vue";
/* <Avatar>'s counterpart for a name nobody has a photograph of: a cartoon character assembled from the name
 * itself, so a persona looks like somebody rather than like a label. It sat in the web app until the two
 * surfaces where you CHOOSE a persona turned out to be extensions, which could reach nothing in there, the
 * same reason <BrandMark> and <SplitView> ended up here. A face is identity, and identity has to be the same
 * drawing on every surface or it is not identity. */
export { default as PersonaFace } from "./components/PersonaFace.vue";
export { type PersonaLike } from "./components/personaFace.js";
// A bordered surface: its own header, its own interrupting strips, one scrolling body. Header and frame are one
// component because every caller of the header wrapped it in the frame, and the min-h-0/overflow-hidden scroll
// contract it owns is the failure three views had each rediscovered, one of them incorrectly.
//
// NAMED FOR THE CONTRACT, not for the shape, and renamed from `Panel` to get there. Thirteen files in this repo
// end in `Panel`. ChatPanel, TerminalPanel, ReviewPanel, AccountPanel, and every one of them means "a region
// of the screen", which is a word this component cannot own. It also meant the one name a view could not learn:
// none of those thirteen used it, and thirty-nine files hand-wrote the scroll contract instead. `ScrollFrame`
// says what it does and collides with nothing (not even Vue Flow's own <Panel>, which DagEditor imports).
export { default as ScrollFrame } from "./components/ScrollFrame.vue";
export { default as Picker } from "./components/Picker.vue";
export { type PickerGroup, type PickerOption, type PickerOptions } from "./components/picker.js";
export { default as ProgressRing } from "./components/ProgressRing.vue";
// The writing field, `ui.input()`'s counterpart for text read in sentences. Borderless, and as tall as what
// has been typed into it.
export { default as ProseField } from "./components/ProseField.vue";
export { default as PullToRefresh } from "./components/PullToRefresh.vue";
// "Which repository", as the narrowing column two workspace-wide boards had each written: the pinned "all" row,
// one number per repository, and the same rail folded into a <Picker> once the split is too narrow for it.
export { default as RepoRail } from "./components/RepoRail.vue";
export { type RepoRailAll, type RepoRailGroup, type RepoRailRow } from "./components/repoRail.js";
// The drag strip between two panes. Four screens had written it by hand before this existed, and the fifth
// caller was an extension, which could not have reached any of the four.
export { default as ResizeSeam } from "./components/ResizeSeam.vue";
// The app's standard touch swap, anchored panel on desktop, bottom sheet on a phone, behind one open flag.
// <Picker> had encapsulated it internally without exposing it, so five other menus wrote the pair out by hand.
export { default as ResponsiveOverlay } from "./components/ResponsiveOverlay.vue";
export { default as Row } from "./components/Row.vue";
export { default as RowGroup } from "./components/RowGroup.vue";
export { default as SearchBar } from "./components/SearchBar.vue";
export { default as SegmentedControl } from "./components/SegmentedControl.vue";
// The accent → palette-slot resolver, exported for the same reason the figure types are: a view that holds
// authored accents (a documentation map's components, say) has to paint them the way a figure would.
export { seriesColor } from "./components/seriesAccent.js";
// The shape of a list that is still loading, built out of real <Row>s so it cannot drift from the list it
// stands in for. The single-bar case needs no component, that is the `skeleton` class on any box.
export { default as SkeletonRows } from "./components/SkeletonRows.vue";
// The index-and-body screen, five views were four implementations of it, and the one that had solved it
// (HubLayout) lived in the web app where no extension could reach it.
export { default as SplitView } from "./components/SplitView.vue";
// Whether that screen has folded its index above its body, what a rail asks so its own compact form arrives at
// the same width the shell's does.
export { useCompact } from "./components/splitView.js";
export { default as StatStrip } from "./components/StatStrip.vue";
export { default as StatusBadge, type StatusVariant } from "./components/StatusBadge.vue";
export { default as StepSection } from "./components/StepSection.vue";
export { Theme } from "./styles/theme.js";
export { installUi } from "./plugin.js";
// The markdown ENGINE is not re-exported here, it ships as `@intentic/ui/markdown` so plain .ts modules
// and unit tests can use it without dragging in this barrel's component graph. See markdown/index.ts.
export { vTw } from "./lib/tw.js";
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
    freshness,
    initialsOf,
    timeAgo,
} from "./lib/format.js";
// The app's one "how far back" vocabulary, the 1h/24h/7d/All pills, the cutoff they mean, and the words a
// caller says about them. Activity and Logs had each written all three.
export { sinceOf, TIME_WINDOWS, type TimeWindow, timeWindowWords, withinWindow } from "./lib/timeWindow.js";
// Path splitting is NOT re-exported here, it ships as `@intentic/ui/path`, for the same reason the
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
// stay open, a test that has to stub matchMedia to compute a colour is a test about the wrong thing.
// The name vocabulary and the set switcher. Asking whether an OPEN string (a manifest's `icon`, an
// `Activation.icon`) is one of these names is `isIconName`, and it lives at `@intentic/ui/icons` rather than
// here: its callers are pure-TypeScript, a renderer's fallback ladder, and the tests that read our own
// extensions' manifests off disk, and reaching it through this barrel boots Picker.vue and wants a DOM.
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
/* Is THIS ELEMENT too narrow for the layout it wants, the pane-shaped question, and almost always the one a
 * view means. `useDevice` answers about the screen, and a view that renders between the rail and a draggable
 * chat panel is never as wide as the screen. */
export { useNarrow } from "./composables/useNarrow.js";
export { useListNavigation } from "./composables/useListNavigation.js";
/* The other half of a narrowing rail: where the reader left it. Four surfaces grew one of these menus and all
 * four forgot the pick the moment you clicked away, because the choice lives in the URL and the rail tile opens
 * a view at its bare address. Shipped as one composable rather than solved four times, for the same reason
 * <SplitView> is here at all. */
export { useRailMemory } from "./composables/useRailMemory.js";
/* The wall clock and the mutation-report shape moved here from the web app when the drafts queue became an
 * extension: both are exactly what every view with a live readout or a user-facing mutation hand-rolls, and the
 * app's four independent `now` intervals were the original argument for the first one. */
export { useNow } from "./composables/useNow.js";
/* WHEN A WAIT IS ALLOWED TO BE SEEN, the gate every <SkeletonRows> and every hand-drawn outline belongs
 * behind, and the half of a loading state that is invisible in a screenshot. A warm read answers under the
 * reveal delay, so the common case paints no placeholder at all; without the gate a 90ms round-trip flashes a
 * field of grey bars and the eye reads it as a fault. It moved here from the web app for the reason <Row>
 * ships beside <RowGroup>: the outline was already in the kit and the rule about when to draw it was not, so
 * every extension that grew a placeholder drew it ungated, three of them, all flashing. */
export { useLoadingReveal } from "./composables/loadingReveal.js";
export { errorMessage, noticeFrom, noticeOf, useAsyncAction } from "./composables/useAsyncAction.js";
export { type ColorScheme, useTheme } from "./composables/useTheme.js";
// The one colour the app wears, as a control. The maths behind it stays inside the kit (themeColor.ts turns
// the picked colour into the ramps every surface, border and link resolves through), a caller only ever
// needs the picker and `useTheme().accent`.
export { default as ColorPicker } from "./components/ColorPicker.vue";
export { type TextSize, useTextSize } from "./composables/useTextSize.js";
