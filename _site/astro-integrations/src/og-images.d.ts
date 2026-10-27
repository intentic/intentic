import type { AstroIntegration } from "astro";
import type { Font } from "satori";

/** One satori element: the `{ type, props }` shape JSX compiles to, written out by hand. */
export interface OgNode {
    type: string;
    props: {
        /** CSS properties in satori's camelCase, with numbers as pixels. */
        style?: Record<string, string | number>;
        children?: string | OgNode[];
        /** An `img`'s picture, as a data URI: a build has no server to fetch from. */
        src?: string;
    };
}

/** What a card is drawn from: the route Astro built and that page's own og: tags. */
export interface OgPage {
    /** The route as Astro names it: no leading slash, `""` for the home page. */
    pathname: string;
    title: string;
    /** Absent when the page has none, or when it only repeats the title. */
    description?: string | undefined;
    url: string;
}

export interface OgTools {
    /** Draws a satori tree to a PNG with the integration's fonts: for a layer a card reuses rather than redraws. */
    rasterize(node: OgNode, size: { width: number; height: number }): Promise<Buffer>;
}

export interface OgImagesOptions {
    width: number;
    height: number;
    fonts: Font[];
    render(page: OgPage, tools: OgTools): OgNode | Promise<OgNode>;
}

export type OgFont = Font;

/** Readable og:title, og:description, og:url and og:image from a built page's <head>; undefined where one is missing. */
export function readOgTags(html: string): {
    title: string | undefined;
    description: string | undefined;
    url: string | undefined;
    image: string | undefined;
};

/** Draw a PNG card beside every built page whose og:image is its own card URL (`ogImageUrl`). */
export function ogImages(options: OgImagesOptions): AstroIntegration;
