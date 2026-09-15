import { appendBlock, isPageBreak, type Context } from "./content";
import type { Block } from "./model";
import { bodyOf, type OdfPackage } from "./pkg";
import { readStyles, type PageGeometry } from "./styles";
import { attr, childElements } from "./xml";

/* An .odt as pages of blocks. */

export interface OdfDocument {
    readonly title: string | undefined;
    readonly geometry: PageGeometry;
    /** One entry per page. A file saved without layout information is one long page, which is how a browser reads. */
    readonly pages: readonly (readonly Block[])[];
    readonly empty: boolean;
}

/** The master page the body's first styled paragraph asks for; its layout is the paper this document is written on. */
const firstMaster = (body: ReturnType<typeof bodyOf>): string | undefined => {
    if (body === undefined) {
        return undefined;
    }
    for (const child of childElements(body)) {
        const master = attr(child, `style:master-page-name`);
        if (master !== undefined) {
            return master;
        }
    }
    return undefined;
};

export const readTextDocument = (pkg: OdfPackage): OdfDocument => {
    const styles = readStyles([pkg.content, pkg.styles]);
    const context: Context = { styles, image: pkg.image, notes: [] };
    const body = bodyOf(pkg.content, `office:text`);
    const pages: Block[][] = [[]];
    const current = (): Block[] => pages.at(-1) ?? [];
    const turn = (): void => {
        if (current().length > 0) {
            pages.push([]);
        }
    };

    for (const child of body === undefined ? [] : childElements(body)) {
        if (isPageBreak(child, context)) {
            turn();
        }
        if (child.tag !== `text:soft-page-break`) {
            appendBlock(child, context, current());
        }
    }
    if (context.notes.length > 0) {
        current().push(...context.notes);
    }

    return { title: pkg.title, geometry: styles.page(firstMaster(body)), pages, empty: pages.every((page) => page.length === 0) };
};
