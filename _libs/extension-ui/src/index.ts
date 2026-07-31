/* The UI kit extensions render with. This entrypoint is the package's ONE public surface (the repo's
 * re-export exception): a curated slice of the app design system (@intentic-app/ui) plus the PrimeVue
 * primitives extension views actually use. At runtime the kit is HOST-PROVIDED — the web app maps this module
 * into its import map (extension-host/hostModules.ts), so third-party bundles marking it external get the
 * shell's own component instances and theming; in-repo builtin extension packages bundle this same module and
 * land on the same instances. Export names are mirrored in ../names.mjs (shim generation + drift assertion).
 * Publishing a typed npm artifact for out-of-repo authors is a marketplace-phase task. */

export {
    BarChart,
    BottomSheet,
    Card,
    cmp,
    Code,
    CopyButton,
    DagGraph,
    type DagEdge,
    type DagNode,
    formatBytes,
    Icon,
    type IconName,
    InfoHint,
    Markdown,
    MarkdownFigure,
    Page,
    PageHeader,
    Picker,
    type PickerGroup,
    type PickerOption,
    type PickerOptions,
    ProgressRing,
    RowGroup,
    Segmented,
    StatRow,
    StatusBadge,
    type StatusVariant,
    StepSection,
    timeAgo,
    useDevice,
    useTheme,
} from "@intentic-app/ui";
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
} from "@intentic-app/ui/markdown";
export { default as Button } from "primevue/button";
export { default as Checkbox } from "primevue/checkbox";
export { default as ContextMenu } from "primevue/contextmenu";
export { default as Dialog } from "primevue/dialog";
export { default as InputText } from "primevue/inputtext";
export type { MenuItem } from "primevue/menuitem";
export { default as Popover } from "primevue/popover";
export { default as Select } from "primevue/select";
export { default as ToggleSwitch } from "primevue/toggleswitch";
