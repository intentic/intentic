import { type RawRoutes, refuse } from "@intentic/contract-serve";
import { json } from "../../transport";
import { workspaceRaw, workspaceThumb } from "./rawFile";
import { landArchive, landUpload } from "./uploads";
import { previewAnswer } from "./previewPage";
import { workspaceDownload, workspaceMedia } from "./served";

// The workspace's byte routes beside its procedures: a file's bytes and tile, a file's upload, a dropped tree's archive,
// and the three an element loads by its ticket (a player's ranges, a selection's ZIP, a served page and its files),
// which reach here through the demo's element addresses (world/elements.ts).
// Spread into daemon/raw.ts's table; a route answered here is taken out of unserved.ts.

const bodyOf = async (request: Request): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await request.arrayBuffer());

export const workspaceRoutes = {
    // A file's bytes for an <img>, a document viewer or a one-file download.
    "GET /workspace/raw": ({ url }) => workspaceRaw(url.searchParams.get(`path`) ?? ``),
    // A picture at tile size, answered as the daemon answers it: SVG is refused (415) for the client to draw the file.
    "GET /workspace/thumb": ({ url }) => workspaceThumb(url.searchParams.get(`path`) ?? ``),
    // A media file's bytes in ranges for a <video> or <audio>, or as an attachment for a one-file download.
    "GET /workspace/media": ({ request, url }) => workspaceMedia(request, url),
    // A selection as one ZIP, its name and contents fixed by the ticket.
    "GET /workspace/download": ({ url }) => workspaceDownload(url),
    // A web page and the files of its repository, under the ticket its address carries.
    "GET /workspace/preview/{ticket}/*": ({ request, url }) => previewAnswer(request, url),
    // One file of a drop or an editor save; a big file comes in parts, each at its `offset`.
    "POST /workspace/upload": async ({ request, url }) => {
        landUpload(url.searchParams.get(`path`) ?? refuse(`invalid path`, 400), Number(url.searchParams.get(`offset`) ?? `0`), await bodyOf(request));
        return json({ ok: true });
    },
    // A dropped tree as one tar, every entry landing where its own path says.
    "POST /workspace/upload-archive": async ({ request }) => {
        try {
            landArchive(await bodyOf(request));
        } catch {
            return json({ error: `invalid path` }, 400);
        }
        return json({ ok: true });
    },
} satisfies RawRoutes;
