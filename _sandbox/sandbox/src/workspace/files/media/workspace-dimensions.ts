import { stat } from "node:fs/promises";
import sharp from "sharp";
import type { WorkspaceDimension } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { thumbnailable } from "../workspace-thumbnail.js";
import { isVideo, videoFacts, videoToolsPresent } from "./workspace-video.js";

// How big a picture or a video is shown, read off its header: sharp parses a picture's without decoding its pixels, and
// ffprobe a video's container. A gallery asks for a folder's worth before drawing a row, so each answer is kept per
// version of the file and the second visit to a folder reads nothing at all.

export type Measured = Omit<WorkspaceDimension, "path">;

// Answers kept; a few numbers each, so the cap is about the map's own size rather than memory.
const CAP = 20_000;
// Files read at once. A picture's header is one short read on libuv's pool, which the daemon's every file read shares;
// a video is an ffprobe process.
const PICTURES_AT_ONCE = 4;
const VIDEOS_AT_ONCE = 2;

const held = new Map<string, Measured | null>();

const remember = (key: string, measured: Measured | null): void => {
    held.set(key, measured);
    if (held.size > CAP) {
        const [oldest] = held.keys();
        if (oldest !== undefined) {
            held.delete(oldest);
        }
    }
};

// EXIF orientations 5 to 8 are a quarter turn: the stored box is the shown one on its side.
const quarterTurned = (orientation: number | undefined): boolean => orientation !== undefined && orientation >= 5 && orientation <= 8;

const pictureBox = async (target: string): Promise<Measured | undefined> => {
    const meta = await sharp(target, { failOn: "none" }).metadata();
    if (meta.width === undefined || meta.height === undefined || meta.width <= 0 || meta.height <= 0) {
        return undefined;
    }
    // A multi-page GIF or WebP reports its pages stacked; the box is one page.
    const height = meta.pageHeight ?? meta.height;
    return quarterTurned(meta.orientation) ? { width: height, height: meta.width } : { width: meta.width, height };
};

const videoBox = async (target: string): Promise<Measured | undefined> => {
    if (!(await videoToolsPresent())) {
        return undefined;
    }
    const facts = await videoFacts(target);
    if (facts === undefined) {
        return undefined;
    }
    return facts.duration === undefined ? { width: facts.width, height: facts.height } : facts;
};

const measureFile = async (target: string): Promise<Measured | undefined> => {
    // allow(silent-catch): a file gone between the listing and this read has no box, and is left out like any other
    const info = await stat(target).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.size === 0) {
        return undefined;
    }
    const key = `${target}\n${info.size}\n${Math.trunc(info.mtimeMs)}`;
    const known = held.get(key);
    if (known !== undefined) {
        return known ?? undefined;
    }
    // allow(silent-catch): a header that will not parse is a file with no box to draw, which is the answer it gets
    const measured = await (isVideo(target) ? videoBox(target) : pictureBox(target)).catch(() => undefined);
    remember(key, measured ?? null);
    return measured;
};

// `work` over `items`, at most `count` at a time.
const pooled = async <T>(items: readonly T[], count: number, work: (item: T) => Promise<void>): Promise<void> => {
    let next = 0;
    const lane = async (): Promise<void> => {
        while (next < items.length) {
            const item = items[next]!;
            next += 1;
            await work(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(count, items.length) }, lane));
};

/** Whether a path is worth measuring here: a picture sharp decodes, or a video. SVG is left to the reader's own engine. */
export const measurable = (path: string): boolean => thumbnailable(path) || isVideo(path);

/**
 * Each resolved file's shown box, in the order given; undefined where it is not a picture or video, or cannot be read.
 * `targets` are already resolved and allowed: the caller has asked whose copy and whether this caller may look.
 */
export const measure = async (targets: readonly string[]): Promise<(Measured | undefined)[]> => {
    const answers = Array.from({ length: targets.length }, (): Measured | undefined => undefined);
    const indexed = targets.map((target, at) => ({ target, at }));
    const into = async ({ target, at }: { readonly target: string; readonly at: number }): Promise<void> => {
        answers[at] = await measureFile(target);
    };
    await Promise.all([
        pooled(
            indexed.filter(({ target }) => thumbnailable(target)),
            PICTURES_AT_ONCE,
            into,
        ),
        pooled(
            indexed.filter(({ target }) => isVideo(target)),
            VIDEOS_AT_ONCE,
            into,
        ),
    ]);
    return answers;
};
