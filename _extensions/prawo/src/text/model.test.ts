import { ArticleBuilder, articleKey, displayNumber, notesFor, parseAddress, selectUnits } from "./model.js";

test("every spelling of an article number is one key", () => {
    for (const spelling of ["Art. 39¹", "39^1", "39[1]", "39(1)", "39_1", "art.39¹"]) {
        expect(articleKey(spelling)).toBe("39^1");
    }
    expect(articleKey("22[1a]")).toBe("22^1a");
    expect(articleKey("Art. 164–179.")).toBe("164-179");
    expect(articleKey("45A")).toBe("45a");
    expect(displayNumber("22^1a")).toBe("22¹ᵃ");
    expect(displayNumber("164-179")).toBe("164–179");
});

test("an address splits into the article and the rest of its marker", () => {
    expect(parseAddress("35 § 1")).toEqual({ article: "35", rest: "§ 1" });
    expect(parseAddress("art. 31 ust 2 pkt. 3")).toEqual({ article: "31", rest: "ust. 2 pkt 3" });
    expect(parseAddress("37 par. 1 pkt 2 lit a")).toEqual({ article: "37", rest: "§ 1 pkt 2 lit. a" });
    expect(parseAddress("§ 4 ust. 1")).toEqual({ article: "4", rest: "ust. 1" });
    expect(parseAddress("zał. 1 § 5 ust. 3")).toEqual({ article: "z1:5", rest: "ust. 3" });
    expect(parseAddress("Załącznik nr 6, § 2")).toEqual({ article: "z6:2", rest: "" });
    expect(() => parseAddress("35 foo 2")).toThrow(/cannot read "35 foo 2"/u);
});

test("units compose their markers from what they sit in, and a selection keeps its subdivisions and notes", () => {
    const builder = new ArticleBuilder("3", "Art. 3", undefined);
    builder.write(builder.open("par", "2", "§ 2."), "Przepisów nie stosuje się do postępowania w sprawach:");
    builder.write(builder.open("pkt", "1", "1)"), "(uchylony)");
    builder.note("4) Uchylony przez art. 1.");
    builder.write(builder.open("pkt", "4", "4)"), "należących do konsulów,");
    builder.write(undefined, "o ile przepisy szczególne nie stanowią inaczej.");
    builder.write(builder.open("par", "3", "§ 3."), "Dalej.");
    builder.note("9) O całym artykule.", true);
    const article = builder.build();
    expect(article.units.map((unit) => unit.marker)).toEqual(["Art. 3 § 2", "Art. 3 § 2 pkt 1", "Art. 3 § 2 pkt 4", "Art. 3", "Art. 3 § 3"]);
    expect(selectUnits(article, "§ 2").map((unit) => unit.marker)).toEqual(["Art. 3 § 2", "Art. 3 § 2 pkt 1", "Art. 3 § 2 pkt 4"]);
    expect(notesFor(article, "§ 2 pkt 1").map((note) => note.text)).toEqual(["4) Uchylony przez art. 1.", "9) O całym artykule."]);
    expect(notesFor(article, "§ 3").map((note) => note.text)).toEqual(["9) O całym artykule."]);
});
