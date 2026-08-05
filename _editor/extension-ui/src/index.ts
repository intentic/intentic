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
    Avatar,
    BarChart,
    BottomSheet,
    Card,
    /* The two halves of a changed-file row ship together because they are always drawn together, and they ship
     * at all for the reason <SplitView> did: the git-history extension is the seventh surface to draw one, and
     * the six that had solved it all sat in the web app where no extension could import them. <ChangeStatusMark>
     * carries the fixed-width cell that keeps a column of paths aligned whatever letter lands in it — the detail
     * a hand-rolled copy gets subtly wrong. */
    ChangeStatusMark,
    type ChangeStatus,
    cmp,
    Code,
    ConfirmDialog,
    ContextMenu,
    CopyButton,
    CountBar,
    type CountItem,
    DagEditor,
    DagGraph,
    type DagEdge,
    type DagNode,
    DiffStat,
    FilterBar,
    Icon,
    type IconName,
    ImageView,
    InfoHint,
    isRenderableImage,
    Markdown,
    MarkdownFigure,
    type NavGroup,
    NavRail,
    Page,
    /* <PageAction> ships beside <PageHeader> for the same reason <Row> ships beside <RowGroup>: handing out the
     * container without the thing that goes in it is what made every view invent one. Five extensions filled
     * `#actions` with a raw PrimeVue <Button> and picked a different cell of its variant matrix each time. */
    PageAction,
    PageHeader,
    Panel,
    Picker,
    type PickerGroup,
    type PickerOption,
    type PickerOptions,
    ProgressRing,
    /* The writing field and the drag seam ship for the same reason <SplitView> did: an extension view that
     * wants prose typeset as a document, or a pane the reader can size, would otherwise hand-roll one — and
     * both recipes have a failure mode (a replica that disagrees with its field; a drag bound to the window)
     * that is invisible until it is in front of somebody. */
    ProseField,
    ResizeSeam,
    Row,
    RowGroup,
    SearchBar,
    Segmented,
    seriesColor,
    sinceOf,
    SplitView,
    StatRow,
    StatusBadge,
    type StatusVariant,
    StepSection,
    TIME_WINDOWS,
    type TimeWindow,
    timeWindowWords,
    useDevice,
    useTheme,
} from "@intentic/ui";
// Also reachable as `@intentic/extension-ui/format` — see the note there for why an extension's pure logic
// wants them without the components attached.
export { formatBytes, formatDate, formatDateTime, formatDayMonth, formatTime, formatTimestamp, formatTokens, timeAgo } from "./format.js";
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
    StatsFigure,
    StatsFigureItem,
} from "@intentic/ui/markdown";
export { default as Button } from "primevue/button";
export { default as Checkbox } from "primevue/checkbox";
export { default as Dialog } from "primevue/dialog";
export { default as InputText } from "primevue/inputtext";
export type { MenuItem } from "primevue/menuitem";
export { default as Popover } from "primevue/popover";
export { default as Select } from "primevue/select";
export { default as ToggleSwitch } from "primevue/toggleswitch";
