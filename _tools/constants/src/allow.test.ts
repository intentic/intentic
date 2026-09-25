import { allowedAt, allowTrailers, pragmaReason } from "./allow.mjs";

describe("pragmaReason", () => {
    it("reads the reason after the check's own pragma, in a line or block comment", () => {
        expect(pragmaReason("x(); // allow(silent-catch): gone already", "silent-catch")).toBe("gone already");
        expect(pragmaReason("/* allow(module-state): one per window */", "module-state")).toBe("one per window");
        expect(pragmaReason(" * allow(module-state): continued", "module-state")).toBe("continued");
    });

    it("refuses a pragma with no reason, for another check, or outside a comment", () => {
        expect(pragmaReason("// allow(silent-catch):   ", "silent-catch")).toBeUndefined();
        expect(pragmaReason("// allow(module-state): why", "silent-catch")).toBeUndefined();
        expect(pragmaReason(`const s = "allow(silent-catch): why";`, "silent-catch")).toBeUndefined();
    });
});

describe("allowedAt", () => {
    const lines = ["// allow(module-state): the app's own", "// and a second line of reason", "export const x = ref(0);", "", "const y = ref(1);"];

    it("finds a pragma anywhere in the comment block directly above the site", () => {
        expect(allowedAt(lines, 3, "module-state")).toBe(true);
    });

    it("does not reach past code or a blank line", () => {
        expect(allowedAt(lines, 5, "module-state")).toBe(false);
    });

    it("reads a legacy marker only where the caller names one", () => {
        const old = ["// silent-catch: the old marker", "} catch {}"];
        expect(allowedAt(old, 2, "silent-catch")).toBe(false);
        expect(allowedAt(old, 2, "silent-catch", /silent-catch:\s*\S/)).toBe(true);
    });
});

describe("allowTrailers", () => {
    it("reads every Allow line with its check and reason, whatever dash separates them", () => {
        const message =
            "feat: x\n\nAllow: layout — the usage module is one set\nAllow: paths - a fixture root\nTest-Note: n\nAllow: vocabulary: quoted\n";
        expect(allowTrailers(message)).toEqual([
            { check: "layout", reason: "the usage module is one set" },
            { check: "paths", reason: "a fixture root" },
            { check: "vocabulary", reason: "quoted" },
        ]);
    });

    it("reads nothing from a line with no reason", () => {
        expect(allowTrailers("Allow: layout —\nAllow: layout")).toEqual([]);
    });
});
