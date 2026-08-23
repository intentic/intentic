import { describe, expect, it } from "vitest";
import { slugFor } from "./output.js";

describe("slugFor", () => {
    it("is readable, stable, and distinguishes URLs that slug identically", () => {
        const first = slugFor("https://docs.ex.com/guide/setup");
        expect(first).toMatch(/^docs-ex-com-guide-setup-[0-9a-f]{8}\.md$/);
        expect(slugFor("https://docs.ex.com/guide/setup")).toBe(first);
        expect(slugFor("https://docs.ex.com/guide/setup?page=2")).not.toBe(first);
    });

    it("cannot spell a path that escapes the output directory", () => {
        const slug = slugFor("https://ex.com/../../etc/passwd");
        expect(slug).not.toContain("/");
        expect(slug).not.toContain("..");
    });
});
