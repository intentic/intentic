/// <reference types="bun" />
/// <reference types="@intentic/testing/globals" />
import { createReleaseResolver, DOWNLOAD_TTL_MS, formatReleaseDate } from "./release";

const redirect = (version: string): Response => new Response(null, { status: 302, headers: { location: `https://github.com/intentic/intentic/releases/tag/v${version}` } });

function fakeGithub(version: string, published = "2026-10-18T09:30:00Z") {
    const calls: string[] = [];
    const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
        calls.push(`${init?.method ?? "GET"} ${input}`);
        if (input.endsWith("/releases/latest") && input.includes("github.com/intentic/intentic/releases")) {
            return Promise.resolve(redirect(version));
        }
        if (input.startsWith("https://api.github.com/")) {
            return Promise.resolve(Response.json({ tag_name: `v${version}`, published_at: published }));
        }
        return Promise.resolve(new Response(null, { status: init?.method === "HEAD" ? 302 : 200 }));
    };
    return { calls, fetchImpl };
}

describe("formatReleaseDate", () => {
    it("writes the day in words", () => {
        expect(formatReleaseDate("2026-10-18")).toBe("18 October 2026");
        expect(formatReleaseDate("2026-01-05T10:00:00Z")).toBe("5 January 2026");
    });
    it("leaves what it cannot read alone", () => {
        expect(formatReleaseDate("yesterday")).toBe("yesterday");
    });
});

describe("createReleaseResolver", () => {
    it("labels the same version the download route serves", async () => {
        const { fetchImpl } = fakeGithub("1.344.0");
        const resolver = createReleaseResolver(fetchImpl);
        const release = await resolver.latestRelease();
        const url = await resolver.resolveDownload((v) => `Intentic-${v}-x64-setup.exe`, "Intentic-setup.exe");
        expect(release).toEqual({ version: "1.344.0", date: "2026-10-18", notes: "https://github.com/intentic/intentic/releases/tag/v1.344.0" });
        expect(url).toBe("https://github.com/intentic/intentic/releases/download/v1.344.0/Intentic-1.344.0-x64-setup.exe");
    });

    it("answers from the cache for an hour, then reads again and follows a new release", async () => {
        let clock = 0;
        let version = "1.343.0";
        const inner = fakeGithub(version);
        const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => inner.fetchImpl(input.replace("1.343.0", version), init);
        const resolver = createReleaseResolver(
            (input, init) => {
                if (input.endsWith("/releases/latest") && input.includes("github.com/intentic")) {
                    return Promise.resolve(redirect(version));
                }
                return fetchImpl(input, init);
            },
            () => clock,
        );
        expect((await resolver.latestRelease())?.version).toBe("1.343.0");
        version = "1.344.0";
        expect((await resolver.latestRelease())?.version).toBe("1.343.0");
        clock = DOWNLOAD_TTL_MS + 1;
        expect((await resolver.latestRelease())?.version).toBe("1.344.0");
    });

    it("keeps the version but drops a date that belongs to another release", async () => {
        const fetchImpl = (input: string): Promise<Response> =>
            Promise.resolve(input.startsWith("https://api.github.com/") ? Response.json({ tag_name: "v9.9.9", published_at: "2026-10-19T00:00:00Z" }) : redirect("1.344.0"));
        expect((await createReleaseResolver(fetchImpl).latestRelease())?.date).toBeNull();
    });

    it("returns null, not a guess, when GitHub cannot be read", async () => {
        const resolver = createReleaseResolver(() => Promise.reject(new Error("offline")));
        expect(await resolver.latestRelease()).toBeNull();
        expect(await resolver.resolveDownload((v) => v, "x")).toBe("https://github.com/intentic/intentic/releases/latest");
    });

    it("falls back to the releases page when the asset is missing", async () => {
        const fetchImpl = (input: string, init?: RequestInit): Promise<Response> =>
            Promise.resolve(init?.method === "HEAD" ? new Response(null, { status: 404 }) : redirect("1.344.0"));
        expect(await createReleaseResolver(fetchImpl).resolveDownload((v) => `a-${v}`, "k")).toBe("https://github.com/intentic/intentic/releases/latest");
    });
});
