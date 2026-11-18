import { createOsDownloads, OS_FALLBACK_PATH, parseOsManifest, parseRange, type OsBucket, type OsObjectBody, type OsRange } from "./os-downloads";

const SHA = "a".repeat(64);
const MANIFEST = {
    version: "1.422.0",
    date: "2026-11-18",
    channel: "stable",
    edition: "server",
    files: {
        iso: { name: "intentic-os-1.422.0-x86_64.iso", size: 10, sha256: SHA },
        qcow2: { name: "intentic-os-1.422.0-x86_64.qcow2", size: 4, sha256: SHA },
    },
};
const ISO_BYTES = "0123456789";

function fakeBucket(objects: Record<string, string>): OsBucket & { gets: { key: string; range?: OsRange }[] } {
    const gets: { key: string; range?: OsRange }[] = [];
    const object = (key: string, text: string, body: string): OsObjectBody => ({
        size: text.length,
        httpEtag: `"${key}"`,
        httpMetadata: { contentType: "application/x-iso9660-image" },
        body: new Response(body).body ?? new ReadableStream(),
        text: () => Promise.resolve(body),
    });
    return {
        gets,
        head: (key) => Promise.resolve(key in objects ? object(key, objects[key] ?? "", "") : null),
        get: (key, options) => {
            gets.push({ key, range: options?.range });
            const text = objects[key];
            if (text === undefined) {
                return Promise.resolve(null);
            }
            const range = options?.range;
            const slice = range === undefined ? text : "suffix" in range ? text.slice(-range.suffix) : text.slice(range.offset, range.offset + range.length);
            return Promise.resolve(object(key, text, slice));
        },
    };
}

const open = () => Promise.resolve(true);
const at = (path: string, init?: RequestInit) => {
    const url = new URL(path, "https://intentic.dev");
    return [new Request(url, init), url] as const;
};

describe("parseOsManifest", () => {
    test("takes what publish-download.sh writes", () => {
        expect(parseOsManifest(JSON.stringify(MANIFEST))).toEqual(MANIFEST);
    });

    test.each([
        ["not JSON", "{"],
        ["no version", JSON.stringify({ ...MANIFEST, version: undefined })],
        ["a version that is not a release", JSON.stringify({ ...MANIFEST, version: "beta" })],
        ["a file name with a path in it", JSON.stringify({ ...MANIFEST, files: { ...MANIFEST.files, iso: { ...MANIFEST.files.iso, name: "../x.iso" } } })],
        ["a short checksum", JSON.stringify({ ...MANIFEST, files: { ...MANIFEST.files, qcow2: { ...MANIFEST.files.qcow2, sha256: "abc" } } })],
    ])("refuses %s", (_, text) => {
        expect(parseOsManifest(text)).toBeNull();
    });
});

describe("parseRange", () => {
    test.each<[string | null, ReturnType<typeof parseRange>]>([
        [null, undefined],
        ["items=0-1", undefined],
        ["bytes=0-1,4-5", undefined],
        ["bytes=2-5", { offset: 2, length: 4 }],
        ["bytes=2-", { offset: 2, length: 8 }],
        ["bytes=8-99", { offset: 8, length: 2 }],
        ["bytes=-3", { suffix: 3 }],
        ["bytes=-99", { suffix: 10 }],
        ["bytes=10-", "unsatisfiable"],
        ["bytes=5-2", "unsatisfiable"],
        ["bytes=-0", "unsatisfiable"],
    ])("%s of 10 bytes", (header, expected) => {
        expect(parseRange(header, 10)).toEqual(expected);
    });
});

describe("the /os/ routes", () => {
    const objects = { "os/stable.json": JSON.stringify(MANIFEST), "os/1.422.0/intentic-os-1.422.0-x86_64.iso": ISO_BYTES };

    test("leave other paths alone", async () => {
        expect(await createOsDownloads().route(...at("/download/"), fakeBucket(objects), open)).toBeUndefined();
        expect(await createOsDownloads().route(...at("/os/1.422.0/../x"), fakeBucket(objects), open)).toBeUndefined();
    });

    test("send /os/iso to the current version's file", async () => {
        const response = await createOsDownloads().route(...at("/os/iso/"), fakeBucket(objects), open);
        expect(response?.status).toBe(302);
        expect(response?.headers.get("location")).toBe("https://intentic.dev/os/1.422.0/intentic-os-1.422.0-x86_64.iso");
    });

    test("send the short links to the page with no manifest, no bucket, or the download switch off", async () => {
        for (const [bucket, downloadsOpen] of [
            [fakeBucket({}), open],
            [undefined, open],
            [fakeBucket(objects), () => Promise.resolve(false)],
        ] as const) {
            const response = await createOsDownloads().route(...at("/os/qcow2"), bucket, downloadsOpen);
            expect(response?.headers.get("location")).toBe(`https://intentic.dev${OS_FALLBACK_PATH}`);
        }
    });

    test("answer /os/latest.json with the manifest, or 503 without one", async () => {
        const found = await createOsDownloads().route(...at("/os/latest.json"), fakeBucket(objects), open);
        expect(found?.status).toBe(200);
        expect(await found?.json()).toEqual(MANIFEST);
        expect((await createOsDownloads().route(...at("/os/latest.json"), fakeBucket({}), open))?.status).toBe(503);
    });

    test("keep the manifest for five minutes", async () => {
        let clock = 0;
        const bucket = fakeBucket(objects);
        const downloads = createOsDownloads(() => clock);
        await downloads.manifest(bucket);
        clock = 5 * 60 * 1000 - 1;
        await downloads.manifest(bucket);
        expect(bucket.gets).toHaveLength(1);
        clock += 1;
        await downloads.manifest(bucket);
        expect(bucket.gets).toHaveLength(2);
    });

    test("stream a whole file as an attachment", async () => {
        const response = await createOsDownloads().route(...at("/os/1.422.0/intentic-os-1.422.0-x86_64.iso"), fakeBucket(objects), open);
        expect(response?.status).toBe(200);
        expect(response?.headers.get("content-length")).toBe("10");
        expect(response?.headers.get("accept-ranges")).toBe("bytes");
        expect(response?.headers.get("content-disposition")).toBe('attachment; filename="intentic-os-1.422.0-x86_64.iso"');
        expect(await response?.text()).toBe(ISO_BYTES);
    });

    test("resume from a range, and refuse one past the end", async () => {
        const path = "/os/1.422.0/intentic-os-1.422.0-x86_64.iso";
        const partial = await createOsDownloads().route(...at(path, { headers: { range: "bytes=4-" } }), fakeBucket(objects), open);
        expect(partial?.status).toBe(206);
        expect(partial?.headers.get("content-range")).toBe("bytes 4-9/10");
        expect(partial?.headers.get("content-length")).toBe("6");
        expect(await partial?.text()).toBe("456789");

        const suffix = await createOsDownloads().route(...at(path, { headers: { range: "bytes=-2" } }), fakeBucket(objects), open);
        expect(suffix?.headers.get("content-range")).toBe("bytes 8-9/10");
        expect(await suffix?.text()).toBe("89");

        const past = await createOsDownloads().route(...at(path, { headers: { range: "bytes=10-" } }), fakeBucket(objects), open);
        expect(past?.status).toBe(416);
        expect(past?.headers.get("content-range")).toBe("bytes */10");
    });

    test("send the whole file when If-Range names another version of it", async () => {
        const path = "/os/1.422.0/intentic-os-1.422.0-x86_64.iso";
        const response = await createOsDownloads().route(...at(path, { headers: { range: "bytes=4-", "if-range": '"old"' } }), fakeBucket(objects), open);
        expect(response?.status).toBe(200);
        expect(await response?.text()).toBe(ISO_BYTES);
    });

    test("answer HEAD without reading the body, and 404 a file that is not there", async () => {
        const bucket = fakeBucket(objects);
        const head = await createOsDownloads().route(...at("/os/1.422.0/intentic-os-1.422.0-x86_64.iso", { method: "HEAD" }), bucket, open);
        expect(head?.status).toBe(200);
        expect(head?.headers.get("content-length")).toBe("10");
        expect(bucket.gets).toHaveLength(0);
        expect((await createOsDownloads().route(...at("/os/1.0.0/nothing.iso"), bucket, open))?.status).toBe(404);
    });

    test("refuse methods other than GET and HEAD", async () => {
        expect((await createOsDownloads().route(...at("/os/iso", { method: "POST" }), fakeBucket(objects), open))?.status).toBe(405);
    });
});
