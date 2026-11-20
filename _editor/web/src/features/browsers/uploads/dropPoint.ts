import { viewportCoords } from "../../../models/browsers/viewportCoords";

// Where a drop lands on the page: the picture's own pixels as a pointer event's are measured (viewportCoords, the same
// letterboxing), then the page's CSS pixels, which is what Chromium places a drag at. A video picture is the display's
// pixels, `scale` of them to a CSS pixel.

export interface PictureGeometry {
    readonly picture: HTMLElement;
    readonly width: number;
    readonly height: number;
    // Picture pixels per CSS pixel of the page.
    readonly scale: number;
}

export const dropPoint = (event: MouseEvent, geometry: PictureGeometry): { readonly x: number; readonly y: number } | undefined => {
    const at = viewportCoords(event, geometry.picture, geometry.width, geometry.height);
    const scale = geometry.scale > 0 ? geometry.scale : 1;
    return at === undefined ? undefined : { x: Math.round(at.x / scale), y: Math.round(at.y / scale) };
};
