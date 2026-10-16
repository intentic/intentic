import { allowedAt, allowingLine, allowTrailers, pragmaReason } from "../allow.mjs";

describe("pragmaReason", () => {
    it("reads the reason after the check's own pragma, in a line or block comment", () => {
        expect(pragmaReason("x(); // allow(silent-catch): gone already", "silent-catch")).toBe("gone already");
        expect(pragmaReason("/* allow(module-state): one per window */", "module-state")).toBe("one per window");
        expect(pragmaReason(" * allow(module-state): continued", "module-state")).toBe("continued");
    });

    it("reads a pragma in a markup comment, without its closer", () => {
        expect(pragmaReason("<!-- allow(buttons): a split button's seam -->", "buttons")).toBe("a split button's seam");
        expect(pragmaReason("    <!--allow(tones): a meter's track-->", "tones")).toBe("a meter's track");
        expect(pragmaReason("<!-- allow(buttons): -->", "buttons")).toBeUndefined();
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

    it("finds a markup pragma in the comment block above a template line", () => {
        const template = ["<div>", "    <!-- allow(tones): a meter's track -->", '    <span class="bg-warning/15" />', "</div>"];
        expect(allowedAt(template, 3, "tones")).toBe(true);
        expect(allowedAt(template, 4, "tones")).toBe(false);
    });

    it("reads a markup comment that spans lines, and a JSX comment, as one block", () => {
        const template = ["<!-- allow(buttons): a split button's seam,", "     welded to its caret -->", "<Button", '    class="rounded-l-none"'];
        expect(allowingLine(template, 3, "buttons")).toBe(1);
        expect(allowedAt(["<!-- a note", "     about it -->", "<Button"], 3, "buttons")).toBe(false);
        expect(allowingLine(["{/* allow(tailwind): half the dot plus half the rule */}", '<span class="w-px" />'], 2, "tailwind")).toBe(1);
        expect(pragmaReason("{/* allow(tailwind): half the dot */}", "tailwind")).toBe("half the dot");
    });

    it("names the line of the pragma that excuses a site", () => {
        expect(allowingLine(lines, 3, "module-state")).toBe(1);
        expect(allowingLine(["x(); // allow(module-state): own line"], 1, "module-state")).toBe(1);
        expect(allowingLine(lines, 5, "module-state")).toBeUndefined();
    });

    it("does not reach past code or a blank line", () => {
        expect(allowedAt(lines, 5, "module-state")).toBe(false);
    });

    it("does not read the retired `// silent-catch: <reason>` marker", () => {
        expect(allowedAt(["// silent-catch: the old marker", "} catch {}"], 2, "silent-catch")).toBe(false);
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
