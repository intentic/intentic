import { defineAsyncComponent } from "vue";
import type DagEditorView from "./components/charts/DagEditor.vue";
import type DagGraphView from "./components/charts/DagGraph.vue";
import { loadChunk } from "./lib/loadChunk.js";
export { clipboardOf, COPIED_MS, type Copied, readClipboard, useCopied, writeClipboard } from "./lib/clipboard.js";
// `browserOwnsClick` is the check a navigational row/tile/menu item runs before also doing app work on a click;
// `appLink` applies the matching anchor attributes for surfaces with no router.
export { appLink, browserOwnsClick } from "./lib/link.js";
// Waiting for a freshly minted preview hostname, and the tab-opening dance for a forwarded port.
export {
    type ForwardedPortTab,
    openForwardedPort,
    parseLoopbackLink,
    type PreviewProbe,
    type PreviewServer,
    type PreviewState,
    type ProbeOptions,
    probePreview,
    probePreviewOnce,
} from "./lib/portPreview.js";
export {
    type ChipVariants,
    type ClassArg,
    type IconButtonVariants,
    type InputVariants,
    type Recipe,
    type SectionLabelVariants,
    type TabVariants,
    type TextButtonVariants,
    ui,
} from "./lib/ui.js";
export {
    type DiffMark,
    diffMark,
    type Signal,
    type TintWeight,
    type Tone,
    toneDot,
    toneFill,
    toneHover,
    toneInk,
    tonePlate,
    toneRim,
    toneTint,
    toneWash,
} from "./lib/tone.js";
export { default as AgentRunButton } from "./components/sandbox/AgentRunButton.vue";
export { type AgentRunAttempt, type AgentRunChoice, type AgentRunPicker, type ModelPicking, useAgentRunPick } from "./composables/useAgentRunPick.js";
export { type FixStanceLook, fixStanceLook } from "./composables/fixStanceLook.js";
export { default as AnchoredOverlay } from "./components/overlays/AnchoredOverlay.vue";
export { default as CoachMark } from "./components/overlays/CoachMark.vue";
// The product's own mark: the lotus alone, or the lotus with the wordmark.
export { default as AppBrand } from "./components/brand/AppBrand.vue";
export { default as Avatar } from "./components/brand/Avatar.vue";
export { type Cross, placeAnchored, type Placement, type Side } from "./lib/anchorPlacement.js";
// What `v-tooltip` takes: a one- or two-word label, or a `Tip` card of headline, figures and key cap.
export { type Tip, type TipRow, type TipTone, type TooltipValue, vTooltip } from "./lib/tooltip.js";
export { isTip, tipText } from "./lib/tipText.js";
export { default as BarChart } from "./components/charts/BarChart.vue";
export { type BarItem } from "./components/charts/barChart.js";
export { default as BottomSheet } from "./components/layout/BottomSheet.vue";
// A phone screen's one creating press, floating over its bottom-right corner.
export { default as FloatingAction } from "./components/layout/FloatingAction.vue";
// For the app's router: a pick that closes a sheet navigates only once the sheet's history entry is gone.
export { overlayBackSettled } from "./composables/useBackDismiss.js";
// <Avatar> for things rather than people: the logo, then glyph, then initials fallback ladder.
export { default as BrandMark } from "./components/brand/BrandMark.vue";
// PrimeVue's Button wrapped so a press whose handler returns a promise locks the button and shows a working state
// once the wait outlasts a beat. `v-action` gives hand-styled elements the same behaviour.
export { default as Button } from "./components/primitives/Button.vue";
export { type ButtonLook, type ButtonTier, type ButtonTone, primeLook } from "./components/primitives/button.js";
export { vAction } from "./lib/pressAction.js";
export { default as Card } from "./components/layout/Card.vue";
// Git's status letter and the +/- line-count badge for a changed file row, shipped together since they're always
// drawn together.
export { default as ChangeStatusMark } from "./components/feedback/ChangeStatusMark.vue";
export { type ChangeStatus } from "./components/feedback/changeStatus.js";
export { type CountBadgeTone, countBadgePlate, countBadgeText } from "./components/feedback/countBadge.js";
export { default as DiffStat } from "./components/charts/DiffStat.vue";
export { default as Code } from "./components/primitives/Code.vue";
// Editable counterpart to <Code>: same styling, with a caret.
export { default as CodeField } from "./components/forms/CodeField.vue";
export { default as ConfirmDialog } from "./components/overlays/ConfirmDialog.vue";
export { default as ContextMenu } from "./components/overlays/ContextMenu.vue";
// A row's or card's own presses: icon buttons with a pointer, one ⋯ and a sheet of them on a phone. <ActionSheet> is
// that sheet on its own, the touch twin of <ContextMenu>.
export { default as OverflowActions } from "./components/overlays/OverflowActions.vue";
export { default as ActionSheet } from "./components/overlays/ActionSheet.vue";
export { type ActionItem } from "./components/overlays/actionItem.js";
export { default as CopyButton } from "./components/primitives/CopyButton.vue";
// One address on one line, editable (a browser's address bar) or read-only (a link to copy or open), in the same box.
export { default as AddressField } from "./components/forms/AddressField.vue";
export { type TallyItem, default as StatusTally } from "./components/charts/StatusTally.vue";
// THE TWO GRAPH COMPONENTS ARE FETCHED WHEN FIRST DRAWN. Each carries Vue Flow and dagre (~190 KB of JS), and exported
// eagerly from this barrel they rode into every startup of the app — the extension host republishes the whole kit —
// though a graph is drawn only on a workflow, pipeline or dependency view. Neither exposes anything through a template
// ref, so the async wrapper is a drop-in; `loadChunk` gives it the same stale-deploy recovery as a lazy route.
// `defineAsyncComponent` drops a generic component's signature, which would leave callers' events and slots untyped.
export const DagEditor =
    // SAFETY: the wrapper renders the component it loads with the props, events and slots it is given.
    defineAsyncComponent(() => loadChunk(() => import("./components/charts/DagEditor.vue"))) as typeof DagEditorView;
export const DagGraph =
    // SAFETY: the wrapper renders the component it loads with the props, events and slots it is given.
    defineAsyncComponent(() => loadChunk(() => import("./components/charts/DagGraph.vue"))) as typeof DagGraphView;
// <Row> plus the expand chevron, ARIA state, open tint and indented rail: the app's one expandable record row.
export { default as DisclosureRow } from "./components/rows/DisclosureRow.vue";
// Row's tier constants (padding, gaps, tones), plus `useRowDensity`: a tier is declared once on <RowGroup> and
// read by every row on that surface. Needed only for a row that can't be expressed as a <Row>.
export { ROW_BLOCK_PAD, ROW_TIERS, ROW_TOGGLE_GAPS, ROW_TONES, type RowDensity, type RowTone, useRowDensity } from "./components/rows/row.js";
// Types only; the layout functions ship as `@intentic/ui/dag` so a plain unit test avoids this barrel's component
// graph. `layoutDag` is exported here too since callers need to know where the graph placed nodes.
export { type DagEdge, type DagNode, layoutDag } from "./components/charts/dagLayout.js";
// Free-text search, narrowing controls and a bare action row above a list.
export { default as FilterBar } from "./components/forms/FilterBar.vue";
// Grows a textarea to fit its content; for cases <ProseField>'s grid replica doesn't cover.
export { growTextarea } from "./lib/growTextarea.js";
export { default as Icon } from "./components/primitives/Icon.vue";
// Shared image viewer (zoom, pan, transparency checkerboard): the workspace file viewer, the SVG preview and both
// sides of a binary diff all use it.
export { default as ImageView } from "./components/primitives/ImageView.vue";
export { type ImageViewState } from "./components/primitives/imageView.js";
// The app's one rename: a name in place, with the field, the affordance and the failure state it takes. The state
// machine behind it is at `@intentic/ui/inline-rename`, for the surfaces that draw their own field (a tab strip, a
// card that must not open while it is being renamed) and must consult the edit.
export { default as InlineRename } from "./components/forms/InlineRename.vue";
export { default as InfoDialog } from "./components/overlays/InfoDialog.vue";
export { default as Beacon } from "./components/feedback/Beacon.vue";
export { default as InfoHint } from "./components/feedback/InfoHint.vue";
export { default as InfoTable } from "./components/feedback/InfoTable.vue";
// Body of one device's sync detail (folders, localhost ports, watcher liveness); the desktop app and web Devices
// tab frame it differently.
export { default as DeviceDetail } from "./components/sandbox/DeviceDetail.vue";
// A device's agent as a group of its own: the build its loop serves, what that loop wants, and the verbs that
// move it. The web Devices tab and the desktop app's manager window draw the same block from their own facts.
export { default as DeviceAgentGroup } from "./components/sandbox/DeviceAgentGroup.vue";
// Just the column of lines, for a surface that lists several agents and can't give each one a group.
export { default as DeviceAgentNotes } from "./components/sandbox/DeviceAgentNotes.vue";
export {
    agentDuties,
    type AgentAction,
    type AgentNote,
    type AgentPanel,
    agentCarries,
    // The panel's notes and its blocked reason as one column, for a surface drawing them outside the group.
    agentLines,
    // The wording both callers share: the badge's word for a reported loop, and the two errands it can carry.
    agentStateNote,
    agentProcessState,
    agentSkewNote,
    type DeviceAgentState,
    restartAgent,
} from "./components/sandbox/deviceAgent.js";
// Verbatim machine output pane under a working row; shared by the desktop app and web, which drive the same
// containers.
export { default as DeviceRunLog } from "./components/sandbox/DeviceRunLog.vue";
export {
    type GroupChip,
    // The folded row's facts as glyphs with a count, and its one status glyph: what <DeviceDetail> draws on a closed line.
    groupChips,
    type GroupStatus,
    groupStatus,
    type GroupSummary,
    groupNeedsAttention,
    groupSummary,
    type DeviceFolderRow,
    type DevicePortRow,
    type DeviceSandboxGroup,
    type DeviceSandboxResources,
    type DeviceSandboxRow,
    // Whether the device is off this sandbox's ports; decides which way a Stop/Start button points.
    mirroringOff,
    // Whether a pairing has a file-sync session at all; decides whether Pause syncing has anything to act on.
    syncSessionLive,
    // One sandbox's machine-resource share as a single line, for display outside the row.
    resourcesSummary,
    // The view's own grouping, for a caller that needs to count sandboxes and attention flags before drawing.
    sandboxGroups,
} from "./components/sandbox/deviceDetail.js";
// Sandbox Resources… dialog: memory/CPU caps, privileged mode, GPU, applied as a recreate onto the same image.
// Its arithmetic also ships DOM-free as `@intentic/ui/sandbox-resources`.
export { default as SandboxResourcesDialog } from "./components/sandbox/SandboxResourcesDialog.vue";
// The sandbox's switcher logo: picture, monogram, or server glyph, with no plate behind it.
export { default as SandboxLogo } from "./components/sandbox/SandboxLogo.vue";
export { askFrom, type EngineFacts, type ResourcesAsk, type ResourcesForm, runningShape } from "./components/sandbox/sandboxResources.js";
// Verb row (buttons, order, labels, which one is destructive) for one sandbox's line; shared by the desktop
// manager and the web Devices tab.
// The open project as a chip with its way out; one control for every surface the project scope narrows.
export { default as ProjectChip } from "./components/sandbox/ProjectChip.vue";
export { default as SandboxVerbs } from "./components/sandbox/SandboxVerbs.vue";
export {
    DESTRUCTIVE_VERB,
    menuVerbs,
    primaryVerb,
    // One version a machine kept, as Roll back's own list offers it, and the question before going back to it.
    type RollbackChoice,
    rollbackToPrompt,
    type SandboxVerb,
    sandboxVerbPrompt,
    type SandboxVerbPrompt,
    VERB_LABEL,
} from "./components/sandbox/sandboxVerbs.js";
export { default as Markdown } from "./components/markdown/Markdown.vue";
// Editable markdown surface with the app's two save policies behind one status line. The underlying engine (a
// bare contenteditable) is not exported; use <NoteEditor> or build a frame around this.
export { default as MarkdownDocument } from "./components/markdown/MarkdownDocument.vue";
export { default as MarkdownFigure } from "./components/charts/MarkdownFigure.vue";
// A rendered document's prose runs and figures in order, for a surface that owns its own `.md-prose` box.
export { default as MarkdownParts } from "./components/markdown/MarkdownParts.vue";
// Renders a mermaid diagram from fence-body text in the app's tokens, for diagrams outside prose that shouldn't
// need wrapping in a markdown document.
export { default as MermaidDiagram } from "./components/charts/MermaidDiagram.vue";
// Centred modal wrapping PrimeVue's Dialog, with a named width and a viewport clamp built in. <ConfirmDialog> and
// <InfoDialog> build on it.
export { default as Modal } from "./components/overlays/Modal.vue";
// `v-middleclick` closes what was pressed (a tab, a pill, a card standing for an open thing); import it where it's
// used, since an unresolved directive silently does nothing.
export { vMiddleclick } from "./lib/middleClick.js";
// Index-column chrome (filter, pinned rows, grouped selection, footnote); the row itself stays the caller's.
export { default as NavRail } from "./components/layout/NavRail.vue";
export { type NavGroup } from "./components/layout/navRail.js";
// Read/curate one markdown note: action cluster, delete confirmation, error strip, built on <ScrollFrame>.
// `useNoteDraft` is its lifecycle.
export { default as NoteEditor } from "./components/forms/NoteEditor.vue";
export { type NoteDraft, type NoteDraftOptions, useNoteDraft } from "./composables/useNoteDraft.js";
// Draft map for unsaved note edits, held once rather than per view, for a pane that gets reused.
export { useKeyedDraft } from "./composables/useKeyedDraft.js";
// Notice: a written sentence, the raw cause, and at most one way out. NoticeStack ranks multiple notices by
// severity and collapses repeats.
export { default as Notice } from "./components/feedback/Notice.vue";
// The centred block a surface shows instead of its content (empty, failed, waiting), sized for a panel or a page.
export { default as EmptyState, type EmptyStateSize, type EmptyStateTone } from "./components/feedback/EmptyState.vue";
export { default as NoticeStack } from "./components/feedback/NoticeStack.vue";
export { type NoticeAction, type NoticeModel, type NoticeTone } from "./components/feedback/notice.js";
export { default as Page } from "./components/layout/Page.vue";
// The only button for <PageHeader #actions>: a named recipe that keeps Button's variant matrix out of callers.
export { default as PageAction } from "./components/layout/PageAction.vue";
export { default as PageHeader } from "./components/layout/PageHeader.vue";
// Escape hatch for a full-screen view; <PageHeader> consumes it, the mobile shell (in the web app) provides it.
export { type PageBack, providePageBack, usePageBack } from "./components/layout/pageBack.js";
export { default as AssistantFace } from "./components/brand/AssistantFace.vue";
export {
    ASSISTANT_ACCESSORIES,
    ASSISTANT_COLORS,
    assistantFace,
    type AssistantAccessory,
    type AssistantColor,
} from "./components/brand/assistantFaces.js";
// A persona's id picks its companion's color, and its name the prop it holds, on every surface.
export { default as PersonaFace } from "./components/brand/PersonaFace.vue";
export { personaAccessory } from "./components/brand/personaAccessory.js";
export { FACE_SIZES, type PersonaLike } from "./components/brand/personaFace.js";
// Bordered surface: own header, own interrupting strips, one scrolling body (the min-h-0/overflow-hidden
// contract). Named for the contract, not the shape; avoids the ambiguous `Panel` name used elsewhere in the app.
export { default as ScrollFrame } from "./components/layout/ScrollFrame.vue";
export { default as Picker } from "./components/forms/Picker.vue";
export { type PickerGroup, type PickerOption, type PickerOptions } from "./components/forms/picker.js";
export { default as ProgressRing } from "./components/charts/ProgressRing.vue";
// Borderless writing field, `ui.input()`'s counterpart for prose; grows with its content.
export { default as ProseField } from "./components/forms/ProseField.vue";
export { default as PullToRefresh } from "./components/layout/PullToRefresh.vue";
// Repository-narrowing rail: a pinned "all" row, one count per repository, folds into a <Picker> when the split
// is too narrow.
export { default as RepoRail } from "./components/layout/RepoRail.vue";
export { type RepoRailAll, type RepoRailGroup, type RepoRailRow } from "./components/layout/repoRail.js";
// Drag strip between two panes.
export { default as ResizeSeam } from "./components/layout/ResizeSeam.vue";
// Anchored panel on desktop, bottom sheet on a phone, behind one open flag.
export { default as ResponsiveOverlay } from "./components/overlays/ResponsiveOverlay.vue";
export { default as Row } from "./components/rows/Row.vue";
export { default as RowGroup } from "./components/rows/RowGroup.vue";
// Non-record lines on a group's surface (empty state, explanatory sentence, add-one prompt), drawn at the
// group's own tier.
export { default as RowNote } from "./components/rows/RowNote.vue";
export { default as SearchBar } from "./components/forms/SearchBar.vue";
export { default as SegmentedControl } from "./components/forms/SegmentedControl.vue";
// ProgressRing's countable sibling: one arc per item, for progress through a list rather than a fraction.
export { default as SegmentRing } from "./components/charts/SegmentRing.vue";
// Accent to palette-slot resolver, for a view with authored accents (e.g. a documentation map) to paint them the
// way a figure would.
export { seriesColor } from "./components/charts/seriesAccent.js";
// Loading placeholder built from real <Row>s so it can't drift from the list it stands in for. A single bar
// needs no component: use the `skeleton` class directly.
export { default as SkeletonRows } from "./components/feedback/SkeletonRows.vue";
// A placeholder drawn exactly as its content last looked in this sandbox: `v-skeleton-source="name"` on the content
// takes its imprint once settled, `<SkeletonSnapshot of="name">` draws it, with its slot as the fallback until one exists.
export { default as SkeletonSnapshot } from "./components/feedback/SkeletonSnapshot.vue";
export { vSkeletonSource } from "./lib/skeleton/skeletonSource.js";
export {
    adoptImprints,
    clearImprints,
    configureSkeletonSnapshots,
    loadImprintScope,
    type SkeletonPersistence,
    type SkeletonSnapshotOptions,
} from "./lib/skeleton/skeletonStore.js";
export { IMPRINT_VERSION, type SkeletonImprint } from "./lib/skeleton/skeletonImprint.js";
// Index-and-body screen layout.
export { default as SplitView } from "./components/layout/SplitView.vue";
// Whether the screen has folded its index above its body; lets a rail match the shell's compact-width breakpoint.
export { useCompact } from "./components/layout/splitView.js";
export { default as Meter, type MeterTone } from "./components/charts/Meter.vue";
export { default as StatStrip } from "./components/charts/StatStrip.vue";
export { default as StatusBadge, type StatusVariant } from "./components/feedback/StatusBadge.vue";
export { default as StepSection } from "./components/layout/StepSection.vue";
// A measured figure (value, unit, qualifier, sample) drawn at one of three ranks (card, settings row, inline).
// Used where the app reports the same experiment result on more than one tab.
export { default as Verdict } from "./components/charts/Verdict.vue";
export { VERDICT_RANKS, VERDICT_TONES, type VerdictSize, type VerdictTone } from "./components/charts/verdict.js";
export { Theme } from "./styles/theme.js";
export { installUi } from "./plugin.js";
export { installChunkRecovery, isStaleChunkError, loadChunk, recoverStaleChunk } from "./lib/loadChunk.js";
// Markdown engine ships separately as `@intentic/ui/markdown`, so plain-TypeScript callers and tests avoid this
// barrel's component graph.
export { vTw } from "./lib/tw.js";
export { type CodeToken, useHighlighter } from "./composables/useHighlighter.js";
export {
    formatBytes,
    formatCompact,
    formatCount,
    formatDate,
    formatDateLong,
    formatDateTime,
    formatDayMonth,
    formatDayMonthTime,
    formatElapsed,
    formatList,
    formatMoney,
    formatPercent,
    formatTime,
    formatTimestamp,
    formatTokens,
    formatWeekdayTime,
    formatWhen,
    freshness,
    initialsOf,
    timeAgo,
} from "./lib/format.js";
// Time-window vocabulary (1h/24h/7d/All): the cutoff each pill means and the words to show for it.
export { sinceOf, timeWindows, type TimeWindow, timeWindowWords, withinWindow } from "./lib/timeWindow.js";
// Path splitting, the Shiki grammar table and `seriesColor` also ship as plain-TypeScript subpaths
// (`@intentic/ui/path`, `@intentic/ui/langs`, `@intentic/ui/series`) so DOM-free callers and tests avoid this
// barrel's component graph. Icon names live at `@intentic/ui/icons` for the same reason; render with <Icon name="…">.
export { type IconName } from "./icons/iconSets.js";
export { type ExplorerStyle, explorerStyles } from "./icons/explorerStyle.js";
export { explorerColorClass, type ExplorerTreatment, explorerTreatment, iconForEntry } from "./icons/fileIcon.js";
// What a file is by its name; pure modules take it from `@intentic/ui/file-format` without this barrel.
export { type FileFormat, formatOf } from "./lib/fileFormat.js";
export { useExplorerStyle } from "./composables/useExplorerStyle.js";
export { commandLang, type CommandOs, osOptions, useOsPreference } from "./composables/useOsPreference.js";
export { type Device, useDevice } from "./composables/useDevice.js";
// Whether this element, not the screen, is too narrow for its layout; useDevice answers about the screen only.
export { useNarrow } from "./composables/useNarrow.js";
export { useListNavigation } from "./composables/useListNavigation.js";
// Every draggable divider in the app; only the per-surface setter differs.
export { type PointerResize, usePointerResize } from "./composables/usePointerResize.js";
// Resets a page-scrolling surface's scroll position when the shown document changes; otherwise the old offset
// points into the new content.
export { useScrollReset } from "./composables/useScrollReset.js";
// What a second sticky element must clear below the first; measured, since a filter bar's height depends on its
// width.
export { type StickyTop, useStickyTop } from "./composables/useStickyTop.js";
// Remembers where a narrowing rail was left, since its choice lives only in the URL and a rail tile opens a view
// at its bare address.
export { useRailMemory } from "./composables/useRailMemory.js";
// Shared wall clock and mutation-report shape, for any view with a live readout or a user-facing mutation.
export { useNow } from "./composables/useNow.js";
export { type Poll, type PollOptions, usePoll, usePollWhile } from "./composables/usePoll.js";
export { useLatest } from "./composables/useLatest.js";
// Gates when a loading placeholder may appear; a fast response resolves within the reveal delay so nothing
// flashes for a normal round trip.
export { useLoadingReveal } from "./composables/loadingReveal.js";
export { type HoverIntent, type HoverIntentOptions, useHoverIntent } from "./composables/useHoverIntent.js";
export { isOverlayTarget, isTypingTarget } from "./lib/eventTarget.js";
export { messageOr, noticeFrom, noticeOf, useAsyncAction, useConcurrentActions } from "./composables/useAsyncAction.js";
// Declares an account preference: read, write, apply and cross-window change notification in one definition, so
// a setting can't be live in one window and stale in another.
export {
    boolPreference,
    definePreference,
    enumPreference,
    numberPreference,
    type PreferenceOptions,
    receivePreferenceChange,
    storedPreference,
    textPreference,
} from "./composables/preference.js";
export { type ColorScheme, type SchemeChoice, useTheme } from "./composables/useTheme.js";
// Accent-colour control; the ramp maths stays in themeColor.ts, callers just use the picker and
// `useTheme().accent`.
export { default as ColorPicker } from "./components/forms/ColorPicker.vue";
export { type TextSize, useTextSize } from "./composables/useTextSize.js";
// Whether the interface moves: the Appearance row, its OS fallback, and the one answer script-played moves ask.
export { lessMotion, MOTION_CHOICES, type MotionChoice, useMotion } from "./motion/choice.js";
