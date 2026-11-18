// INTENTIC OS DOWNLOADS: the installer ISO and VM disk, served from the R2 bucket os.yml publishes to
// (_os/os-image/publish-download.sh). The ISO is past a GitHub release asset's 2 GB cap, so unlike the desktop
// routes these are not release redirects: the worker streams the bucket's objects itself, ranges included, so a
// download that drops resumes.
//
//   /os/latest.json        the manifest (os/stable.json): version, date, each file's name, size and sha256
//   /os/iso, /os/qcow2     302 to the current version's file, so the link never carries a version
//   /os/<version>/<file>   the file itself, immutable; SHA256SUMS sits beside the two images
import { z } from "zod";

/** The parts of an R2 object this module reads. Declared, not imported, like worker-runtime.d.ts. */
export interface OsObject {
    readonly size: number;
    readonly httpEtag: string;
    readonly httpMetadata?: { contentType?: string; cacheControl?: string };
}

export interface OsObjectBody extends OsObject {
    readonly body: ReadableStream;
    text(): Promise<string>;
}

export type OsRange = { offset: number; length: number } | { suffix: number };

/** The parts of an R2 bucket binding this module calls. */
export interface OsBucket {
    head(key: string): Promise<OsObject | null>;
    get(key: string, options?: { range?: OsRange }): Promise<OsObjectBody | null>;
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;

const osFileSchema = z.object({
    name: z.string().regex(FILE_NAME),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

/** os/stable.json as publish-download.sh writes it. */
const osManifestSchema = z.object({
    version: z.string().regex(VERSION),
    date: z.string().catch(""),
    channel: z.string().catch("stable"),
    edition: z.string().catch("server"),
    files: z.object({ iso: osFileSchema, qcow2: osFileSchema }),
});

export type OsManifest = z.infer<typeof osManifestSchema>;

const OS_MANIFEST_KEY = "os/stable.json";
const OS_LATEST_PATH = "/os/latest.json";
/** Where a download link lands when there is nothing to hand over: the page's own Intentic OS section. */
export const OS_FALLBACK_PATH = "/download/#os";
const MANIFEST_TTL_MS = 5 * 60 * 1000;

const FILE_PATH = /^\/os\/(?<version>\d+\.\d+\.\d+)\/(?<file>[A-Za-z0-9][A-Za-z0-9._-]*)$/u;
const SHORT_PATHS = { "/os/iso": "iso", "/os/qcow2": "qcow2" } as const satisfies Record<string, keyof OsManifest["files"]>;
const isShortPath = (path: string): path is keyof typeof SHORT_PATHS => Object.hasOwn(SHORT_PATHS, path);

/** The manifest's text when it parses to the shape the page and the routes rely on, else null. */
export function parseOsManifest(text: string): OsManifest | null {
    try {
        const parsed = osManifestSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
    } catch (error) {
        // Not JSON: the same answer as a manifest of the wrong shape, said once in the log.
        console.warn(`[os] the manifest is not JSON: ${String(error)}`);
        return null;
    }
}

/**
 * A single `Range: bytes=…` against a file of `size` bytes: the R2 range, `undefined` for no (or an ignorable) header,
 * or `"unsatisfiable"`. Several ranges are answered with the whole file, which HTTP allows.
 */
export function parseRange(header: string | null, size: number): OsRange | "unsatisfiable" | undefined {
    const match = header === null ? null : /^bytes=(?<start>\d*)-(?<end>\d*)$/u.exec(header.trim());
    if (match?.groups === undefined) {
        return undefined;
    }
    const { start = "", end = "" } = match.groups;
    if (start === "") {
        const suffix = Number(end);
        return end === "" || suffix === 0 ? "unsatisfiable" : { suffix: Math.min(suffix, size) };
    }
    const offset = Number(start);
    if (offset >= size) {
        return "unsatisfiable";
    }
    const last = end === "" ? size - 1 : Math.min(Number(end), size - 1);
    return last < offset ? "unsatisfiable" : { offset, length: last - offset + 1 };
}

const notFound = (): Response => new Response("No such Intentic OS download.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

function fileHeaders(head: OsObject, fileName: string): Headers {
    const headers = new Headers({
        "accept-ranges": "bytes",
        etag: head.httpEtag,
        "content-type": head.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": head.httpMetadata?.cacheControl ?? "public, max-age=31536000, immutable",
    });
    if (fileName !== "SHA256SUMS") {
        headers.set("content-disposition", `attachment; filename="${fileName}"`);
    }
    return headers;
}

/** The bytes a request asks of a file: undefined for all of it. An If-Range naming another etag gets all of it. */
function requestedSpan(request: Request, head: OsObject): { offset: number; length: number } | "unsatisfiable" | undefined {
    const ifRange = request.headers.get("if-range");
    const range = ifRange === null || ifRange === head.httpEtag ? parseRange(request.headers.get("range"), head.size) : undefined;
    if (range === undefined || range === "unsatisfiable") {
        return range;
    }
    return "suffix" in range ? { offset: head.size - range.suffix, length: range.suffix } : range;
}

export function createOsDownloads(now: () => number = Date.now) {
    let cached: { manifest: OsManifest | null; at: number } | undefined;

    async function manifest(bucket: OsBucket | undefined): Promise<OsManifest | null> {
        if (bucket === undefined) {
            return null;
        }
        if (cached !== undefined && now() - cached.at < MANIFEST_TTL_MS) {
            return cached.manifest;
        }
        let parsed: OsManifest | null = null;
        try {
            const object = await bucket.get(OS_MANIFEST_KEY);
            parsed = object === null ? null : parseOsManifest(await object.text());
        } catch (error) {
            console.warn(`[os] the manifest could not be read: ${String(error)}`);
        }
        cached = { manifest: parsed, at: now() };
        return parsed;
    }

    async function serveFile(bucket: OsBucket, key: string, request: Request, fileName: string): Promise<Response> {
        const head = await bucket.head(key);
        if (head === null) {
            return notFound();
        }
        const headers = fileHeaders(head, fileName);
        const span = requestedSpan(request, head);
        if (span === "unsatisfiable") {
            headers.set("content-range", `bytes */${head.size}`);
            return new Response(null, { status: 416, headers });
        }
        headers.set("content-length", String(span?.length ?? head.size));
        if (span !== undefined) {
            headers.set("content-range", `bytes ${span.offset}-${span.offset + span.length - 1}/${head.size}`);
        }
        const status = span === undefined ? 200 : 206;
        if (request.method === "HEAD") {
            return new Response(null, { status, headers });
        }
        const object = await bucket.get(key, span === undefined ? undefined : { range: span });
        return object === null ? notFound() : new Response(object.body, { status, headers });
    }

    return {
        manifest,

        /**
         * The response for an /os/ path, or undefined when the path is not one of these routes. `downloadsOpen` is the
         * live download switch: closed, the short links go to the page instead (the files themselves stay reachable,
         * since a resumed download names one).
         */
        async route(request: Request, url: URL, bucket: OsBucket | undefined, downloadsOpen: () => Promise<boolean>): Promise<Response | undefined> {
            const path = url.pathname.replace(/\/$/u, "");
            if (!path.startsWith("/os/")) {
                return undefined;
            }
            if (request.method !== "GET" && request.method !== "HEAD") {
                return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
            }
            if (path === OS_LATEST_PATH) {
                const current = await manifest(bucket);
                // 503 not 200-with-nothing, as /desktop/latest.json: the page reads anything but a manifest as "none yet".
                return Response.json(current, {
                    status: current === null ? 503 : 200,
                    headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
                });
            }
            if (isShortPath(path)) {
                const current = await manifest(bucket);
                if (current === null || !(await downloadsOpen())) {
                    return Response.redirect(new URL(OS_FALLBACK_PATH, url).href, 302);
                }
                return Response.redirect(new URL(`/os/${current.version}/${current.files[SHORT_PATHS[path]].name}`, url).href, 302);
            }
            const { version, file } = FILE_PATH.exec(path)?.groups ?? {};
            if (version === undefined || file === undefined || bucket === undefined) {
                return undefined;
            }
            return serveFile(bucket, `os/${version}/${file}`, request, file);
        },
    };
}
