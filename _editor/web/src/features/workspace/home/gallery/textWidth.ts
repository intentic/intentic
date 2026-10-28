// The width a line of text takes in a font, measured on one canvas every caption shares, without laying anything out:
// what a gallery caption asks before it decides which part of a name to give up (HomeGalleryTile.vue).

let ruler: CanvasRenderingContext2D | null | undefined;

/** The width of `text` in the CSS `font`, in CSS pixels; undefined where the canvas cannot measure (a test's DOM). */
export const textWidth = (text: string, font: string): number | undefined => {
    ruler ??= document.createElement(`canvas`).getContext(`2d`);
    if (ruler === null) {
        return undefined;
    }
    ruler.font = font;
    return ruler.measureText(text).width;
};
