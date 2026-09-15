import type { Css } from "./styles";

/* What a rendered document is, between the XML and the DOM: a tree of blocks with CSS already resolved. Pure data,
   so the parse is testable without a browser and the renderer has no parsing left to do. */

export type Inline =
    | { readonly kind: "text"; readonly text: string; readonly css: Css }
    | { readonly kind: "break" }
    | { readonly kind: "tab" }
    | { readonly kind: "link"; readonly href: string; readonly inlines: readonly Inline[] }
    | { readonly kind: "image"; readonly src: string; readonly alt: string; readonly css: Css };

export interface Cell {
    readonly blocks: readonly Block[];
    readonly css: Css;
    readonly colspan: number;
    readonly rowspan: number;
}

export interface Row {
    readonly cells: readonly Cell[];
    readonly css: Css;
    readonly header: boolean;
}

export type Block =
    // `level` 0 is body text; 1-6 are headings, which carry the document's outline.
    | { readonly kind: "paragraph"; readonly level: number; readonly css: Css; readonly inlines: readonly Inline[] }
    | { readonly kind: "list"; readonly ordered: boolean; readonly type: string; readonly start?: number; readonly items: readonly (readonly Block[])[] }
    | { readonly kind: "table"; readonly columns: readonly string[]; readonly rows: readonly Row[]; readonly css: Css }
    | { readonly kind: "image"; readonly src: string; readonly alt: string; readonly css: Css }
    | { readonly kind: "box"; readonly css: Css; readonly blocks: readonly Block[] };

export const textOfInlines = (inlines: readonly Inline[]): string =>
    inlines
        .map((inline) => {
            if (inline.kind === `text`) {
                return inline.text;
            }
            return inline.kind === `link` ? textOfInlines(inline.inlines) : ``;
        })
        .join(``);

/** The text a block carries, for an outline entry or a slide's title. */
export const textOfBlock = (block: Block): string => {
    switch (block.kind) {
        case `paragraph`:
            return textOfInlines(block.inlines);
        case `list`:
            return block.items.flat().map((inner) => textOfBlock(inner)).join(` `);
        case `box`:
            return block.blocks.map((inner) => textOfBlock(inner)).join(` `);
        case `table`:
            return block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.blocks.map((inner) => textOfBlock(inner)))).join(` `);
        default:
            return ``;
    }
};
