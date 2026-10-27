import { refuse } from "@intentic/contract-serve";
import { bytesOf } from "./bytes";

// GET /workspace/raw: a file's bytes typed by its extension, the read behind every picture, document viewer and
// one-file download. Dropped binaries answer their real bytes, the recording's documents theirs, everything else its text.

const TYPES = new Map(
    Object.entries({
        html: `text/html; charset=utf-8`,
        css: `text/css; charset=utf-8`,
        svg: `image/svg+xml`,
        png: `image/png`,
        jpg: `image/jpeg`,
        jpeg: `image/jpeg`,
        webp: `image/webp`,
        gif: `image/gif`,
        wav: `audio/wav`,
        mp3: `audio/mpeg`,
        mp4: `video/mp4`,
        webm: `video/webm`,
        pdf: `application/pdf`,
        zip: `application/zip`,
        json: `application/json`,
        docx: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
    }),
);

export const typeOf = (path: string): string => TYPES.get(path.slice(path.lastIndexOf(`.`) + 1).toLowerCase()) ?? `text/plain; charset=utf-8`;

export const workspaceRaw = (path: string): Response =>
    new Response(bytesOf(path) ?? refuse(`No such file: ${path}`, 404), { status: 200, headers: { "content-type": typeOf(path) } });

// Every picture in this fixture is already small, so a tile is the file itself; only SVG is refused, as the daemon does.
export const workspaceThumb = (path: string): Response => (path.endsWith(`.svg`) ? refuse(`not a picture this can draw`, 415) : workspaceRaw(path));
