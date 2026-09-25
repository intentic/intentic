import { computed, nextTick, onBeforeUnmount, onMounted, type Ref, ref } from "vue";
import { variableRows } from "../../../../lib/rowWindow";
import { useRowWindow } from "../../../../lib/useRowWindow";
import type { InlineEdit } from "./inlineEdit";
import type { MoreRow, Row } from "./treeRows";

// The rows actually in the DOM. Expanded folders can run to thousands of rows, and one the reader cannot see still
// costs a component, its handlers and a diff on every tick, so only the rows crossing the viewport are built; the rest
// is a spacer's worth of height. Also where a row's element is found, scrolled to and focused (roving tabindex).

export interface TreeWindowHost {
    readonly rows: Readonly<Ref<readonly (Row | MoreRow)[]>>;
    // The keyboard's row, which focusLead brings into view and focuses.
    readonly lead: Readonly<Ref<string | null>>;
    // An inline create field is allotted rows under its folder's row: one for the field, a second for a refusal.
    readonly edit: Readonly<Ref<InlineEdit>>;
    readonly createError: Readonly<Ref<string | undefined>>;
}

export const useTreeWindow = (host: TreeWindowHost) => {
    // The scrollport the window measures against.
    const scroller = ref<HTMLElement>();
    // Everything above the first row (the top spacer, and the root's phantom create row), measured rather than assumed.
    const preamble = ref<HTMLElement>();
    // A hidden row wearing the real classes, so the stylesheet stays the one place a row's height is decided.
    const probeRow = ref<HTMLElement>();
    const headroom = ref(0);
    const rowHeight = ref(22);
    let sizes: ResizeObserver | undefined;
    // Read from an observer, never per scroll, since asking the DOM for an offset forces layout.
    const remeasure = (): void => {
        headroom.value = preamble.value?.offsetHeight ?? 0;
        rowHeight.value = Math.max(1, probeRow.value?.offsetHeight ?? 0);
    };
    onMounted(() => {
        sizes = new ResizeObserver(remeasure);
        for (const el of [preamble.value, probeRow.value]) {
            if (el !== undefined) {
                sizes.observe(el);
            }
        }
        remeasure();
    });
    onBeforeUnmount(() => sizes?.disconnect());

    // Allotted rather than measured, and set on the element as an explicit height, so the two cannot disagree.
    const createBlock = computed(() => rowHeight.value * (host.createError.value === undefined ? 1 : 2));
    // A row is one row tall, plus the create block when it is the folder the new entry will land in.
    const rowHeights = computed(() => {
        const edit = host.edit.value;
        const creatingIn = edit.kind === `creating` ? edit.dir : undefined;
        return host.rows.value.map((row) =>
            !(`more` in row) && creatingIn === row.entry.path ? rowHeight.value + createBlock.value : rowHeight.value,
        );
    });
    const rowWindow = useRowWindow(scroller, () => variableRows(rowHeights.value), { offsetTop: () => headroom.value });
    // The rows actually built, each carrying where it sits: they are placed, so the ones left out cost nothing.
    const painted = computed(() =>
        host.rows.value
            .slice(rowWindow.first.value, rowWindow.last.value)
            .map((row, at) => ({ row, top: rowWindow.rows.value.offsetOf(rowWindow.first.value + at) })),
    );

    // Row elements by path: plain Map, kept in sync by the :ref callback on each row.
    const rowEls = new Map<string, HTMLElement>();
    const setRowEl = (path: string, el: unknown): void => {
        if (el) {
            rowEls.set(path, el as HTMLElement);
        } else {
            rowEls.delete(path);
        }
    };
    // Brings a row into view and waits for it to be built, answering its element; undefined when the path is not a row.
    // The window scrolls by index, since a row it has not built has no element.
    const showRow = async (path: string): Promise<HTMLElement | undefined> => {
        const index = host.rows.value.findIndex((row) => !(`more` in row) && row.entry.path === path);
        if (index === -1) {
            return undefined;
        }
        await rowWindow.show(index);
        const el = rowEls.get(path);
        // Settles whatever drift is left between the window's row height and the browser's layout; a no-op in view.
        el?.scrollIntoView({ block: `nearest` });
        return el;
    };
    // Scrolls before focusing: the lead may be outside the window, and focus() on a row that isn't built goes nowhere.
    const focusLead = async (): Promise<void> => {
        await nextTick();
        if (host.lead.value === null) {
            return;
        }
        (await showRow(host.lead.value))?.focus();
    };
    // Focuses the row explicitly, since Safari and macOS Firefox don't focus a <button> on click by default.
    const focusRow = (path: string): void => rowEls.get(path)?.focus();

    return {
        scroller,
        preamble,
        probeRow,
        rowHeight,
        createBlock,
        painted,
        // The spacer's height; bound at the template's top level, since a ref reached through an object prints "[object Object]".
        treeHeight: rowWindow.total,
        onScroll: rowWindow.onScroll,
        setRowEl,
        showRow,
        focusLead,
        focusRow,
    };
};
