import { derivablePath } from "./shadows.js";

// Which written files get a shadow at once: documents fileq can render, inside the project, named as fileq keys them.

test("a document inside the project is derived under its project-relative path", () => {
    expect(derivablePath("/src/app", "/src/app/docs/spec.docx")).toBe("docs/spec.docx");
    expect(derivablePath("/src/app", "/src/app/notes/run.ipynb")).toBe("notes/run.ipynb");
    expect(derivablePath("/src/app", "report.pdf")).toBe("report.pdf");
});

test("source, plain text and anything outside the project is left alone", () => {
    expect(derivablePath("/src/app", "/src/app/src/index.ts")).toBeUndefined();
    expect(derivablePath("/src/app", "/src/app/README.md")).toBeUndefined();
    expect(derivablePath("/src/app", "/elsewhere/spec.docx")).toBeUndefined();
    expect(derivablePath("/src/app", "/src/app")).toBeUndefined();
});
