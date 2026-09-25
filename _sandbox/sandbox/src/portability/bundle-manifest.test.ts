import { BundleManifestSchema } from "@intentic/sandbox-contract";
import { convertDocument } from "../store/conversions.js";
import { bundleManifestDocument, unreadableManifest } from "./bundle-arrival.js";

// A bundle's manifest read through the conversions its format has had: what a version 2 bundle (2026-08-25 to 09-02)
// lacked is derived, and what cannot be read says why.

const read = (raw: unknown) => BundleManifestSchema.safeParse(convertDocument(bundleManifestDocument.history, "object", raw).value);

test("a version 2 manifest reads as version 3, its repositories derived from its definition", () => {
    const parsed = read({
        version: 2,
        createdAt: 1,
        secrets: false,
        definition: {
            schemaVersion: 1,
            repositories: [
                { id: "app", remote: "https://example.com/app.git" },
                { id: "site", remote: "https://example.com/site.git" },
            ],
        },
        excluded: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ version: 3, repos: ["app", "site"] });
});

test("the embedded definition converts like any definition: a retired setting goes, a host becomes a device", () => {
    const parsed = read({
        version: 3,
        createdAt: 1,
        secrets: false,
        repos: [],
        definition: { schemaVersion: 1, settings: { terseOutput: true, hashlineEdits: true } },
        excluded: [],
    });
    expect(parsed.data?.definition.settings).toEqual({ hashlineEdits: true });
});

test("a manifest from before definitions, or from a newer format, is told exactly that", () => {
    expect(unreadableManifest({ version: 1 })).toBe(
        "this bundle was exported before 2026-08-25, in a format that did not carry the sandbox's definition; export it again from its source",
    );
    expect(unreadableManifest({ version: 4 })).toBe("this bundle was exported by a newer intentic (format 4); update this sandbox to take it in");
    expect(unreadableManifest("garbage")).toBe("the bundle manifest is not readable by this daemon");
});
