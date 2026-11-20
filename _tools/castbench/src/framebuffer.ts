import { MARKER, type MarkerValue, readMarker } from "./marker.js";

// The X display's own pixels, read where Xvfb keeps them: started with `-fbdir`, it holds its screen in an XWD file it
// maps, which this maps too and reads with no X request at all. Polled every millisecond for the marker, it says when
// a frame the page drew reached the display, so a run splits its latency into Chromium's share (drawn → on the display)
// and the pipeline's (on the display → decoded), which voxl's loadgen measures directly by drawing straight into X.

export interface XwdLayout {
    readonly width: number;
    readonly height: number;
    readonly bytesPerLine: number;
    readonly bitsPerPixel: number;
    // Where the first row of pixels starts in the file: past the header and its colour map.
    readonly pixelOffset: number;
    // Byte offset of the green channel within a pixel: the marker is grey, so one channel is its brightness.
    readonly greenOffset: number;
}

// The XWD file header (X11's XWDFileHeader): 25 big-endian 32-bit fields, then the window name, then `ncolors` 12-byte
// colour entries, then the pixels.
export const parseXwdHeader = (bytes: Uint8Array): XwdLayout => {
    if (bytes.byteLength < 100) {
        throw new Error("not an XWD file: shorter than its header");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, 100);
    const field = (index: number): number => view.getUint32(index * 4);
    const headerSize = field(0);
    const byteOrder = field(7);
    const bitsPerPixel = field(11);
    const greenMask = field(15);
    if (bitsPerPixel !== 32) {
        throw new Error(`castbench reads a 32-bit framebuffer, and this one is ${bitsPerPixel}-bit`);
    }
    // The green channel's byte within the 32-bit pixel, counted from the pixel's first byte in memory.
    const greenShift = Math.log2(greenMask & -greenMask) / 8;
    return {
        width: field(4),
        height: field(5),
        bytesPerLine: field(12),
        bitsPerPixel,
        pixelOffset: headerSize + field(19) * 12,
        greenOffset: byteOrder === 0 ? greenShift : 3 - greenShift,
    };
};

// The marker as the framebuffer shows it, its corner at (x, y) on the screen.
export const readFramebufferMarker = (file: Uint8Array, layout: XwdLayout, x: number, y: number): MarkerValue | undefined =>
    readMarker((dx, dy) => file[layout.pixelOffset + (y + dy) * layout.bytesPerLine + (x + dx) * 4 + layout.greenOffset] ?? 0);

export interface DisplayProbe {
    // When each marker value was first on the display since the last reset, by the frame number it carried.
    readonly firstSeen: () => ReadonlyMap<number, number>;
    readonly reset: () => void;
    readonly stop: () => void;
}

// Polls the marker on the display at `origin` (the viewport's top-left on the screen) every millisecond.
export const probeDisplay = (path: string, origin: { readonly x: number; readonly y: number }, clock: () => number): DisplayProbe => {
    const file = Bun.mmap(path, { shared: true });
    const layout = parseXwdHeader(file);
    const seen = new Map<number, number>();
    let last: number | undefined;
    const timer = setInterval(() => {
        const value = readFramebufferMarker(file, layout, origin.x + MARKER.x, origin.y + MARKER.y);
        if (value !== undefined && value.frame !== last) {
            last = value.frame;
            if (!seen.has(value.frame)) {
                seen.set(value.frame, clock());
            }
        }
    }, 1);
    return {
        firstSeen: () => seen,
        reset: () => {
            seen.clear();
            last = undefined;
        },
        stop: () => clearInterval(timer),
    };
};
