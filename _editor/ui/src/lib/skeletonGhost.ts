import { type FunctionalComponent, h, type StyleValue, type VNode, type VNodeChild } from "vue";
import { type ImprintBlock, type ImprintElement, type ImprintNode, type ImprintText, isImprintBlock, isImprintText, type SkeletonImprint } from "./skeletonImprint.js";

// Draws an imprint (skeletonImprint.ts) back as elements: kept elements with their own classes, so the ghost lays
// out, wraps and themes as the content does now; text as one `.skeleton` bar per line it filled; pictures, fields and
// buttons as `.skeleton` blocks of the size they were. The root carries `.skeleton-snapshot`, which makes the whole
// thing inert to the pointer and to selection.

type Table = readonly string[];

/** What a ghost element is drawn with: its own class and style, a cell's span, and Vue's scoped markers. */
interface GhostAttributes {
    class?: (string | undefined)[];
    style?: string;
    colspan?: number;
    rowspan?: number;
    tabindex?: number;
    type?: `button`;
    role?: `status`;
    inert?: ``;
    "aria-hidden"?: `true`;
    "aria-busy"?: `true`;
    "aria-label"?: string;
    [scoped: `data-${string}`]: ``;
}

const px = (value: number): string => `${value}px`;

// A line of text, or several: a wrapper span so the line keeps its parent's line-height (in a flex row a bare bar
// would be a flex item only as tall as itself), with a break between lines so each bar is one line long.
const textOf = (node: ImprintText): VNode =>
    h(
        `span`,
        null,
        node.w.flatMap((width, index) => [
            ...(index === 0 ? [] : [h(`br`)]),
            h(`span`, { class: `skeleton inline-block align-middle`, style: { width: px(width), maxWidth: `100%`, height: px(node.h) } }),
        ]),
    );

const blockOf = (node: ImprintBlock, table: Table): VNode => {
    const [width, height] = node.b;
    const style: StyleValue = {
        display: node.i === 1 ? `inline-block` : `block`,
        verticalAlign: node.i === 1 ? `middle` : undefined,
        width: px(width),
        height: px(height),
        ...(node.n === 1 ? { minWidth: px(width), flexShrink: 0 } : { maxWidth: `100%` }),
        borderRadius: node.r === undefined ? undefined : table[node.r],
    };
    return h(`span`, { class: [node.g === 1 ? undefined : `skeleton`, node.c === undefined ? undefined : table[node.c]], style });
};

// Kept buttons are only the unpainted ones (a painted one became a block); out of the tab order, as the whole ghost is.
const UNFOCUSED = new Set([`button`, `summary`]);

const isDataName = (name: string | undefined): name is `data-${string}` => name?.startsWith(`data-`) === true;

const attributesOf = (node: ImprintElement, table: Table, root: GhostAttributes): GhostAttributes => {
    const attributes: GhostAttributes = { ...root, class: [node.c === undefined ? undefined : table[node.c], ...(root.class ?? [])] };
    if (node.s !== undefined) {
        attributes.style = table[node.s];
    }
    if (node.x !== undefined) {
        [attributes.colspan, attributes.rowspan] = node.x;
    }
    if (UNFOCUSED.has(node.e)) {
        attributes.tabindex = -1;
    }
    if (node.e === `button`) {
        attributes.type = `button`;
    }
    for (const marker of node.v ?? []) {
        const name = table[marker];
        if (isDataName(name)) {
            attributes[name] = ``;
        }
    }
    return attributes;
};

const elementOf = (node: ImprintElement, table: Table, root: GhostAttributes = {}): VNode =>
    h(
        node.e,
        attributesOf(node, table, root),
        node.k?.map((child) => nodeOf(child, table)),
    );

const nodeOf = (node: ImprintNode, table: Table): VNodeChild => {
    if (node === 0) {
        return ` `;
    }
    if (isImprintText(node)) {
        return textOf(node);
    }
    if (isImprintBlock(node)) {
        return blockOf(node, table);
    }
    return elementOf(node, table);
};

interface GhostProps {
    readonly imprint: SkeletonImprint;
    /** Announced while it shows; without one the ghost is hidden from assistive technology, as a decoration. */
    readonly label?: string | undefined;
}

const rootOf = (label: string | undefined): GhostAttributes => {
    const root: GhostAttributes = { class: [`skeleton-snapshot`], "data-skeleton-snapshot": `` };
    if (label === undefined) {
        root[`aria-hidden`] = `true`;
        root.inert = ``;
        return root;
    }
    root.role = `status`;
    root[`aria-busy`] = `true`;
    root[`aria-label`] = label;
    return root;
};

export const SkeletonGhost: FunctionalComponent<GhostProps> = ({ imprint, label }) => elementOf(imprint.root, imprint.t, rootOf(label));
SkeletonGhost.props = [`imprint`, `label`];
