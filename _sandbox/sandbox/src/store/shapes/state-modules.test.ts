import { declaredDocument } from "./state-modules.js";

// The index generator reads what a history document declares of itself straight off its definition's text, so the
// bundle's /history table is written from the documents (store/evolution/history-state.ts). These pin what it reads,
// and that a history document saying nothing, or saying it any way but a literal, is refused rather than skipped.

const definition = { module: "said.ts", name: "saidDocument" };
const at = (text: string): ReturnType<typeof declaredDocument> =>
    declaredDocument(definition, text, text.indexOf("defineDocument(") + "defineDocument(".length);

test("a history document's literal portability, note and directory are read off its definition", () => {
    expect(at('export const saidDocument = defineDocument({ root: "history", path: "said.json", portability: "carry", schema: S });')).toEqual({
        ...definition,
        history: { path: "said.json", portability: "carry" },
    });
    const multiline = [
        "export const saidDocument = defineDocument({",
        "    // A comment naming path: \"elsewhere\" and a quote's \"portability\" is not a key.",
        '    schema: z.object({ path: z.string(), portability: z.literal("secret"), note: z.string() }),',
        '    root: "history",',
        '    path: "said/",',
        "    directory: true,",
        "    /* why it stays */ portability: \"identity\",",
        '    note: "Pair again, \\"here\\".",',
        "});",
    ].join("\n");
    expect(at(multiline)).toEqual({ ...definition, history: { path: "said/", portability: "identity", note: 'Pair again, "here".' } });
});

test("a document on another root declares nothing and is read as its name alone", () => {
    expect(at('export const saidDocument = defineDocument({ path: ".intentic/said.json", schema: S });')).toEqual(definition);
    expect(at('export const saidDocument = defineDocument({ root: "auth", path: "said.json", schema: S });')).toEqual(definition);
});

test("a history document that does not say, or says it other than as literals, is refused", () => {
    expect(at('export const saidDocument = defineDocument({ root: "history", path: "said.json", schema: z.object({ portability: z.string() }) });')).toBe(
        "undeclared",
    );
    expect(at('export const saidDocument = defineDocument({ root: "history", path: "said.json", portability: CARRY, schema: S });')).toBe("undeclared");
    expect(at('export const saidDocument = defineDocument({ root: "history", path: "said.json", portability: "carry", note: "a" + "b", schema: S });')).toBe(
        "undeclared",
    );
    expect(at('export const saidDocument = defineDocument({ root: "history", path: PATH, portability: "carry", schema: S });')).toBe("undeclared");
});
