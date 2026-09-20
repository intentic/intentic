import { describe, expect, test } from "vitest";
import { AreaFolderSchema } from "./areas.js";

// What an area may name. These refusals are load-bearing rather than cosmetic: an area's folders become the fence
// every file route refuses on, so they are the whole of what keeps a grant below maintainer out of the config that
// decides what agents may do.
describe("AreaFolderSchema", () => {
    test("an ordinary folder, at any depth, is an area", () => {
        expect(AreaFolderSchema.safeParse("support").success).toBe(true);
        expect(AreaFolderSchema.safeParse("finance/reports").success).toBe(true);
    });

    test("the workspace root is not an area: naming no area at all is what granting everything means", () => {
        expect(AreaFolderSchema.safeParse(".").success).toBe(false);
        expect(AreaFolderSchema.safeParse("/").success).toBe(false);
    });

    test("a folder that climbs out of the workspace is refused however it is spelled", () => {
        expect(AreaFolderSchema.safeParse("../etc").success).toBe(false);
        expect(AreaFolderSchema.safeParse("support/../..").success).toBe(false);
    });

    test("the sandbox's own configuration and its outbox can never be named", () => {
        for (const folder of [".intentic", ".intentic/config", ".intentic/config/hooks", "public", "public/site"]) {
            expect(AreaFolderSchema.safeParse(folder).success, folder).toBe(false);
        }
    });

    test("a folder that merely starts with one of those names is ordinary", () => {
        expect(AreaFolderSchema.safeParse("publications").success).toBe(true);
        expect(AreaFolderSchema.safeParse("support/public-notes").success).toBe(true);
    });
});
