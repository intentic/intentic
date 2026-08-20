/* The UI kit extensions render with. This entrypoint is the package's ONE public surface (the repo's
 * re-export exception): a curated slice of the app design system (@intentic/ui) plus the PrimeVue
 * primitives extension views actually use. At runtime the kit is HOST-PROVIDED — the web app maps this module
 * into its import map (extension-host/hostModules.ts), so third-party bundles marking it external get the
 * shell's own component instances and theming; in-repo builtin extension packages bundle this same module and
 * land on the same instances. Export names are mirrored in ../names.mjs (shim generation + drift assertion).
 * Publishing a typed npm artifact for out-of-repo authors is a marketplace-phase task. */

/* <Row> ships beside <RowGroup> because shipping the container WITHOUT the row is what made every extension
 * write its own: five views imported the group, found nothing to put in it, and hand-rolled a row body each.
 * The comment lives out here rather than beside the name because extensionUiNames.test.ts parses this brace
 * block for names, and reads a comment inside it as exports that do not exist.
 *
 * <SplitView> is here for exactly the same reason one level up: five screens are an index beside a body, and the
 * one implementation that had solved it (HubLayout) sat in the web app where no extension could import it. */
export {
    /* <AgentRunButton> and its state ship because FOUR extensions start an agent for the user — pipelines,
     * deployments, maintenance, acceptance — and each of them had reached a different answer about how you
     * choose what it spends: three had no control at all and named the model in a tooltip, the fourth grew a
     * chip of its own. That is the same divergence <SplitView> and <Row> were shipped to end, arriving on the
     * one control in the app where getting it wrong costs money rather than pixels. `useAgentRunPick` is the
     * half that needs `api.models` and takes it as an argument, so the kit stays free of the extension API. */
    AgentRunButton,
    type AgentRunChoice,
    type AgentRunPicker,
    type ModelPicking,
    useAgentRunPick,
    /* <AnchoredOverlay> ships because the alternative on this surface is PrimeVue's <Popover>, and six extension
     * views had already reached for it. Popover measures and dismisses against the OPENER's window, so in a
     * popped-out panel it opens off the bottom edge, over its own trigger, and cannot be clicked shut — the
     * failure the kit's own tooltip directive exists to avoid. */
    AnchoredOverlay,
    Avatar,
    BarChart,
    BottomSheet,
    /* <BrandMark> ships because the drafts queue is the second surface to draw a platform as its brand (the
     * capability cards were the first) — and because its fallback is the part a hand-roll skips: a platform
     * with no installed connector still has to render as SOMETHING, and the monogram is that something. */
    BrandMark,
    Card,
    /* The window a copy has to go through. Missing from this surface is why git-history called
     * `navigator.clipboard` directly and copying a commit SHA out of a POPPED-OUT panel silently did nothing:
     * the module-global navigator belongs to the opener, whose document isn't focused, so the write rejects
     * and every call site swallows it. */
    clipboardOf,
    /* The two halves of a changed-file row ship together because they are always drawn together, and they ship
     * at all for the reason <SplitView> did: the git-history extension is the seventh surface to draw one, and
     * the six that had solved it all sat in the web app where no extension could import them. <ChangeStatusMark>
     * carries the fixed-width cell that keeps a column of paths aligned whatever letter lands in it — the detail
     * a hand-rolled copy gets subtly wrong. */
    ChangeStatusMark,
    type ChangeStatus,
    ui,
    Code,
    /* <CodeField> ships beside <Code> because shipping the reader WITHOUT the writer is what made the memory
     * extension put a bare grey <textarea> next to a coloured block of the very same file: the kit had no way
     * to say "this text, in its own colours, with a caret in it". */
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
    FilterBar,
    Icon,
    type IconName,
    ImageView,
    /* <InfoDialog> and <InfoTable> ship beside <ConfirmDialog> and <Row> for the reason everything else here
     * does: an extension with something to EXPLAIN rather than confirm, or a block of label→value facts to lay
     * out, would otherwise hand-roll a dialog shell and a two-column grid — and the grid is where a hand-roll
     * drifts, because keeping the value column aligned across rows is the whole of it. */
    InfoDialog,
    InfoHint,
    InfoTable,
    isRenderableImage,
    Markdown,
    MarkdownFigure,
    /* <Modal> ships for the reason <ConfirmDialog> and <InfoDialog> already do, and it is the one they were
     * both missing: an extension whose dialog is neither a confirm nor an explainer had nothing to reach for
     * but PrimeVue's Dialog and a width typed into a style attribute — which is exactly how the app itself
     * ended up with thirteen widths and one viewport clamp between seventeen dialogs. */
    Modal,
    type NavGroup,
    NavRail,
    /* <NoteEditor> and `useNoteDraft` ship because TWO extensions are a pane that reads a markdown file, lets
     * somebody correct it and lets them delete it — knowledge and memory — and they had built the same thing
     * twice: the same Copy/Edit/Delete cluster, the same Cancel/Save pair, the same in-place confirmation, the
     * same draft-or-file binding, the same read-and-write-on-one-surface rule. They had already drifted in the
     * ways a second copy does: one cleared its confirmation when a write failed and the other did not, and
     * NEITHER caught a failing write, so the error strip filled in from the mutation while the click handler's
     * promise rejected into the console. The component is the chrome and the composable is the lifecycle,
     * separately, because what a note LOOKS like past the frame is exactly where the two panes differ. */
    NoteEditor,
    type NoteDraft,
    type NoteDraftOptions,
    useNoteDraft,
    /* <NoticeStack> and its model ship beside <ConfirmDialog> for the same reason <InfoDialog> does: a view
     * with several async actions needs somewhere for their failures to land that isn't one action's own row,
     * and a hand-rolled error strip is the first thing to disagree with the app's about tone and dismissal.
     *
     * <Notice> — THE SINGLE ONE — was missing from that shipment, and it is the same mistake <Row>/<RowGroup>
     * and <PageAction>/<PageHeader> each record one release earlier: the container went out without the thing
     * that goes in it. Notice.vue's own comment says every view that hand-rolled `ui.alertDanger()` around an
     * interpolated error string renders it instead, "which is what makes the app's failures sound like one
     * product rather than like sixty throw sites" — and the app took that sweep, 107 call sites of it. The
     * extensions could not: the kit handed out the stack and kept the row, so thirteen of them went on
     * hand-rolling the strip. Most of a view's failures are ONE at a time; the stack is the rarer case. */
    type NoticeModel,
    type NoticeTone,
    type NoticeAction,
    Notice,
    NoticeStack,
    Page,
    /* <PageAction> ships beside <PageHeader> for the same reason <Row> ships beside <RowGroup>: handing out the
     * container without the thing that goes in it is what made every view invent one. Five extensions filled
     * `#actions` with a raw PrimeVue <Button> and picked a different cell of its variant matrix each time. */
    PageAction,
    PageHeader,
    ScrollFrame,
    /* <PersonaFace> ships because the TWO surfaces in the whole app where you choose a persona are both out
     * here — an automation's "Runs as" and a workflow step's "Acts as" — and neither could reach the drawing
     * every surface that merely LISTS a persona already uses. So the one screen where you are picking a person
     * by sight was the one screen showing a line of text. It is exported alongside <Picker>'s own `face` option
     * field, which is what most callers actually want: hand the row a persona and the picker draws it. */
    PersonaFace,
    type PersonaLike,
    Picker,
    type PickerGroup,
    type PickerOption,
    type PickerOptions,
    ProgressRing,
    /* <RepoRail> ships for the reason <SplitView> did, one level in: two extensions scope a workspace-wide
     * board to one repository — maintenance and pipelines — and both had written the same column. Same pinned
     * "All repositories" row outside every group, same one-number-per-row rule with the second fact as its
     * colour, same swap to a <Picker> at the width the split folds at. What differs between them is the report
     * behind it, which is why the rows arrive as data. */
    RepoRail,
    type RepoRailAll,
    type RepoRailGroup,
    type RepoRailRow,
    /* The writing field and the drag seam ship for the same reason <SplitView> did: an extension view that
     * wants prose typeset as a document, or a pane the reader can size, would otherwise hand-roll one — and
     * both recipes have a failure mode (a replica that disagrees with its field; a drag bound to the window)
     * that is invisible until it is in front of somebody. */
    ProseField,
    ResizeSeam,
    /* <ResponsiveOverlay> is the one to reach for over <AnchoredOverlay> above whenever the panel is a MENU: it
     * is the same anchored box on desktop and a thumb-reachable sheet on a phone, behind one open flag. Extension
     * views are read on both, and a popover pinned to a 24px trigger is not usable on a touch screen. */
    ResponsiveOverlay,
    Row,
    RowGroup,
    SearchBar,
    SegmentedControl,
    seriesColor,
    sinceOf,
    /* The gate <SkeletonRows> and every hand-drawn outline go behind. It ships WITH the outline rather than
     * after it, because the three extensions that already drew one drew it ungated: a placeholder that flashes
     * for 90ms on a warm read is worse than no placeholder at all, and that is not a thing anybody notices in
     * the screenshot they ship. See its note in the kit for the two thresholds. */
    useLoadingReveal,
    /* <SkeletonRows> ships beside <RowGroup> for the third time this file makes the argument: the container
     * without the WAIT is what made three extensions write their own. Pipelines, deployments and maintenance
     * each hand-rolled a placeholder board, and the row-shaped half of all three is this component — same
     * bars, same widths walked in order, same `aria-hidden` under the caller's one status region. What they
     * could not get right by hand is the part that does not show up in a screenshot: a bar is thinner than the
     * text it replaces, so an outline built out of divs is shorter than the list that lands and the page jumps
     * as it fills. This one renders REAL <Row>s, so it inherits the tier's padding and keeps the height. */
    SkeletonRows,
    SplitView,
    StatStrip,
    StatusBadge,
    type StatusVariant,
    StepSection,
    TIME_WINDOWS,
    type TimeWindow,
    timeWindowWords,
    /* Whether the <SplitView> above has folded its index above its body. What a rail asks before swapping itself
     * to a compact control, so the two halves of one screen change shape at one width. Outside a split it falls
     * back to the device, which is the only narrow case left. */
    useCompact,
    useDevice,
    /* Arrow keys / Home / End / Enter over a list, with the wrap-around and the scroll-into-view already
     * decided. Ships because a keyboard-navigable list is the shape half these views are, and the parts a
     * hand-roll leaves out (wrapping at the ends, keeping the active row in view) are invisible on a mouse. */
    useListNavigation,
    /* <useNow> and <useAsyncAction> ship because the drafts queue was the first extension with a live countdown
     * and a page of mutations — the two shapes every such view hand-rolls, one interval and one busy flag at a
     * time, each subtly wrong (a clock that keeps ticking with nothing on screen; a double-click firing twice). */
    useNow,
    errorMessage,
    noticeFrom,
    noticeOf,
    useAsyncAction,
    /* "Is my own element too narrow for this layout" — the question every extension view actually means, since it
     * renders into a pane the reader can drag to half its width, not into the window. */
    useNarrow,
    /* Where the reader left a narrowing rail. Ships for the reason <SplitView> did: three extension views grew
     * the same index column, all three keep the pick in the URL, and all three lost it the moment you clicked the
     * tile again — because a tile opens a view at its bare address. Solving that per extension would be three
     * copies of one rule about what a link means versus what a memory is allowed to guess. */
    useRailMemory,
    useTheme,
} from "@intentic/ui";
// Also reachable as `@intentic/extension-ui/format` — see the note there for why an extension's pure logic
// wants them without the components attached.
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
/* The figure vocabulary that <Markdown> renders from prose and <MarkdownFigure> renders from data. Types only —
 * an extension needs them to BUILD a figure out of facts it already holds (a dependency graph, a staleness
 * tally) rather than round-tripping through markdown to draw one. The parser and the document splitter stay out
 * of the kit: they are the prose surface's job, and <Markdown> already does it. */
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
/* The raw primitives, kept deliberately short. Handing out a primitive the KIT already wraps is how an
 * extension screen ends up wearing OS chrome next to the app's own: `Select` and `InputText` used to ship here
 * and four views took them, so a dropdown with a different focus ring sat beside <Picker> and a text field with
 * different padding beside `ui.input`. Those two are gone — <Picker> and `ui.input()` are the spellings.
 * <Dialog> was the third, and it is gone for the same reason: it stayed "until the kit has a general dialog
 * shell", six extension views took it, and every one of them typed its own width into a style attribute with
 * no viewport clamp — the exact spread that <Modal> above now exists to end. The shell is here, so the raw one
 * is not. <Popover> stays only because <ResponsiveOverlay>/<AnchoredOverlay> do not yet cover every menu shape,
 * and it is on the same clock: those two are the ones that open in the right window when a panel is popped out. */
export { default as Button } from "primevue/button";
export { default as Checkbox } from "primevue/checkbox";
export type { MenuItem } from "primevue/menuitem";
export { default as Popover } from "primevue/popover";
export { default as ToggleSwitch } from "primevue/toggleswitch";
