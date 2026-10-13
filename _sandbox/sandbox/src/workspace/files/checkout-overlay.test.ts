import { NO_OVERLAY, overlaidView, overlayOf } from "./checkout-overlay.js";

// Roots no test creates: these views never find a file on disk, so only what the overlay and the index say is read.
const checkout = "/nonexistent/checkout";
const shared = "/nonexistent/shared";

describe("overlayOf", () => {
    test("joins each repo's rows onto its folder and sorts them into added, gone and renamed", () => {
        const overlay = overlayOf([
            {
                repo: "intentic",
                changes: [
                    { path: "_os/README.md", status: "added" },
                    { path: "src/kept.ts", status: "modified" },
                    { path: "src/dropped.ts", status: "deleted" },
                    { path: "_os/installer/bib-config.toml", status: "renamed", from: "_os/installer/config.toml" },
                ],
            },
            { repo: "root", changes: [{ path: "notes.md", status: "added" }] },
        ]);
        expect(overlay.added).toEqual(["intentic/_os/README.md", "intentic/_os/installer/bib-config.toml", "notes.md"]);
        expect([...overlay.gone]).toEqual(["intentic/src/dropped.ts", "intentic/_os/installer/config.toml"]);
        expect([...overlay.renamed]).toEqual([["intentic/_os/installer/config.toml", "intentic/_os/installer/bib-config.toml"]]);
    });
});

describe("overlaidView", () => {
    test("strikes what the conversation deleted or renamed away from the shared index's answers", async () => {
        const overlay = overlayOf([
            {
                repo: "intentic",
                changes: [
                    { path: "src/gone.ts", status: "deleted" },
                    { path: "src/new.ts", status: "renamed", from: "src/old.ts" },
                ],
            },
        ]);
        const view = overlaidView({
            checkout,
            shared,
            overlay,
            matching: async () => ["intentic/src/gone.ts", "intentic/src/old.ts", "intentic/src/kept.ts"],
        });
        expect(await view.inFolder("src", 10)).toEqual(["intentic/src/new.ts", "intentic/src/kept.ts"]);
        expect([...view.renamed]).toEqual([["intentic/src/old.ts", "intentic/src/new.ts"]]);
    });

    test("searches a literal name, so brackets in a file name are not read as a pattern", async () => {
        const globs: string[] = [];
        const matching = async (glob: string): Promise<string[]> => {
            globs.push(glob);
            return [];
        };
        const view = overlaidView({ checkout: shared, shared, overlay: NO_OVERLAY, matching });
        await view.endingWith("pages/[id].vue", 10);
        expect(globs).toEqual(["**/pages/\\[id\\].vue"]);
    });
});
