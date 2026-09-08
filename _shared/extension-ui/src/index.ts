// The UI kit extensions render with: a curated slice of the app design system (@intentic/ui) plus the PrimeVue
// primitives extension views use. Host-provided at runtime, mapped into the import map so third-party and in-repo
// bundles share the same component instances.

// Documents `<Row>`/`<RowGroup>`/`<SplitView>` together, here rather than by name: extensionUiNames.test.ts parses
// this block for names and would misread an attached comment as one.
export {
    // `useAgentRunPick` takes `api.models` as an argument, so the kit itself stays free of the extension API.
    AgentRunButton,
    type AgentRunChoice,
    type AgentRunPicker,
    type ModelPicking,
    useAgentRunPick,
    // Use over PrimeVue's Popover in a popped-out panel: Popover measures against the opener's window and can open
    // off-screen, unclosable.
    AnchoredOverlay,
    Avatar,
    // A click handler returning a promise auto-locks the button and shows a wait state; `vAction` is the same for a
    // raw `<button v-action="run">`, imported explicitly since an unresolved directive silently does nothing.
    Button,
    vAction,
    BarChart,
    BottomSheet,
    // Renders a platform's brand; falls back to a monogram when no connector for it is installed.
    BrandMark,
    Card,
    // Use over raw `navigator.clipboard`: in a popped-out panel it belongs to the unfocused opener, so a direct write
    // rejects.
    clipboardOf,
    // A row that is both a link and a control: modifier clicks (Ctrl/⌘/Shift/Alt) fall through to the browser, a plain
    // click acts.
    browserOwnsClick,
    appLink,
    // Opens a freshly minted preview hostname in a tab once it is ready.
    openForwardedPort,
    // `ChangeStatusMark` is fixed-width, so a column of paths stays aligned whatever status letter lands in it.
    ChangeStatusMark,
    type ChangeStatus,
    ui,
    Code,
    // The editable counterpart to `Code`: syntax-coloured text with a caret in it.
    CodeField,
    ConfirmDialog,
    ContextMenu,
    CopyButton,
    StatusTally,
    type TallyItem,
    DagEditor,
    DagGraph,
    type DagEdge,
    type DagNode,
    DiffStat,
    // An expandable row; don't reuse `(i)` as its toggle glyph, `<InfoHint>` already uses `(i)` for a hover card.
    DisclosureRow,
    FilterBar,
    Icon,
    type IconName,
    ImageView,
    // For explaining, not confirming, or laying out label→value facts; keeps the value column aligned across rows.
    InfoDialog,
    InfoHint,
    InfoTable,
    isRenderableImage,
    Markdown,
    // An editable markdown document (author-facing), unlike `Markdown`'s read-only render.
    MarkdownDocument,
    MarkdownFigure,
    // For a dialog that is neither a confirm nor an explainer; clamps width to the viewport, unlike a raw PrimeVue
    // Dialog.
    Modal,
    type NavGroup,
    NavRail,
    // `NoteEditor` is the chrome, `useNoteDraft` the lifecycle, kept separate since a note's look past the frame
    // differs by pane.
    NoteEditor,
    type NoteDraft,
    type NoteDraftOptions,
    useNoteDraft,
    // A keyed store of drafts that must outlive the pane showing them; deleting a key (`undefined`) is what a picker's
    // "Unsaved" reads.
    useKeyedDraft,
    // `NoticeStack` holds failures from several async actions; `Notice` is the single one, for the common one-at-a-time
    // case.
    type NoticeModel,
    type NoticeTone,
    type NoticeAction,
    Notice,
    NoticeStack,
    Page,
    PageAction,
    PageHeader,
    ScrollFrame,
    // Also reachable via `Picker`'s `face` option: hand it a persona and the picker draws it.
    PersonaFace,
    type PersonaLike,
    Picker,
    type PickerGroup,
    type PickerOption,
    type PickerOptions,
    ProgressRing,
    // A workspace board scoped to one repo; always includes a pinned "All repositories" row outside the groups.
    RepoRail,
    type RepoRailAll,
    type RepoRailGroup,
    type RepoRailRow,
    // Prose typeset as a document (`ProseField`) and a pane the reader can resize (`ResizeSeam`).
    ProseField,
    ResizeSeam,
    // Use over `AnchoredOverlay` for a menu: anchored on desktop, a thumb-reachable sheet on a phone, one open flag.
    ResponsiveOverlay,
    Row,
    RowGroup,
    SearchBar,
    SegmentedControl,
    seriesColor,
    sinceOf,
    // Gates a skeleton placeholder so a flash on a fast read never shows; see its own note in the kit for the two
    // thresholds.
    useLoadingReveal,
    // Renders real `<Row>`s rather than divs, so its height matches what replaces it and the page doesn't jump.
    SkeletonRows,
    SplitView,
    StatStrip,
    StatusBadge,
    type StatusVariant,
    StepSection,
    TIME_WINDOWS,
    type TimeWindow,
    timeWindowWords,
    // Whether the enclosing `<SplitView>` has folded to compact; outside a split it falls back to device width.
    useCompact,
    useDevice,
    // Arrow/Home/End/Enter navigation over a list, with wrap-around and scroll-into-view handled.
    useListNavigation,
    // A ticking clock (`useNow`) and a busy/error flag for one mutation at a time (`useAsyncAction`).
    useNow,
    errorMessage,
    noticeFrom,
    noticeOf,
    useAsyncAction,
    // Whether the element itself is narrow, not the window; views render into a resizable pane.
    useNarrow,
    // Remembers a rail's last pick across reopening a tile, which otherwise opens at the view's bare address.
    useRailMemory,
    // Resets the page scrollport to top when a rail selection changes; the other half of `scroll="page"`.
    useScrollReset,
    // Height the next pinned element must clear, for a page-scrolling view stacking pinned bars.
    type StickyTop,
    useStickyTop,
    useTheme,
} from "@intentic/ui";
// Also reachable as `@intentic/extension-ui/format`, without the components attached.
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
    timeAgo,
} from "./format.js";
// Types only, so an extension can build a figure straight from facts it holds instead of round-tripping through
// markdown. The parser and document splitter stay in `<Markdown>`, not here.
export type {
    BarsFigure,
    BarsFigureItem,
    DagFigure,
    DagFigureEdge,
    DagFigureNode,
    Figure,
    FigureAccent,
    MermaidFigure,
    StatsFigure,
    StatsFigureItem,
} from "@intentic/ui/markdown";
// Raw PrimeVue primitives kept deliberately few: prefer `Picker`/`ui.input()`/`Modal` over
// `Select`/`InputText`/`Dialog`.
// `Popover` stays only where `AnchoredOverlay`/`ResponsiveOverlay` don't yet cover a menu shape.
export { default as Checkbox } from "primevue/checkbox";
export type { MenuItem } from "primevue/menuitem";
export { default as Popover } from "primevue/popover";
export { default as ToggleSwitch } from "primevue/toggleswitch";
