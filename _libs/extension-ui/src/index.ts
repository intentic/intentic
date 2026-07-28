/* The UI kit extensions render with. This entrypoint is the package's ONE public surface (the repo's
 * re-export exception): a curated slice of the app design system (@intentic-app/ui) plus the PrimeVue
 * primitives extension views actually use. At runtime the kit is HOST-PROVIDED — the web app maps this module
 * into its import map (extension-host/hostModules.ts), so third-party bundles marking it external get the
 * shell's own component instances and theming; in-repo builtin extension packages bundle this same module and
 * land on the same instances. Export names are mirrored in ../names.mjs (shim generation + drift assertion).
 * Publishing a typed npm artifact for out-of-repo authors is a marketplace-phase task. */

export {
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
    Page,
    PageHeader,
    ProgressRing,
    RowGroup,
    Segmented,
    StatusBadge,
    type StatusVariant,
    StepSection,
    timeAgo,
    useDevice,
    useTheme,
} from "@intentic-app/ui";
export { default as Button } from "primevue/button";
export { default as Checkbox } from "primevue/checkbox";
export { default as ContextMenu } from "primevue/contextmenu";
export { default as Dialog } from "primevue/dialog";
export { default as InputText } from "primevue/inputtext";
export type { MenuItem } from "primevue/menuitem";
export { default as Popover } from "primevue/popover";
export { default as Select } from "primevue/select";
export { default as ToggleSwitch } from "primevue/toggleswitch";
