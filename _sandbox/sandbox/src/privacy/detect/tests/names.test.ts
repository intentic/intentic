import { detectPersonalData } from "../detect.js";
import { lemmaCandidates } from "../inflection.js";

const names = (text: string): string[] => detectPersonalData(text, { classes: new Set(["person-name"]) }).map((span) => span.value);

describe("Polish inflection", () => {
    // Each paradigm the rules claim, from the inflected form back to the nominative the registers hold.
    test("first names reduce to their nominative", () => {
        const cases: ReadonlyArray<readonly [string, string]> = [
            ["jana", "jan"],
            ["janowi", "jan"],
            ["janem", "jan"],
            ["janie", "jan"],
            ["marka", "marek"],
            ["markowi", "marek"],
            ["markiem", "marek"],
            ["marku", "marek"],
            ["anny", "anna"],
            ["annie", "anna"],
            ["annę", "anna"],
            ["anną", "anna"],
            ["anno", "anna"],
            ["katarzynie", "katarzyna"],
            ["katarzyną", "katarzyna"],
            ["pawła", "paweł"],
            ["pawle", "paweł"],
            ["piotrze", "piotr"],
            ["agnieszce", "agnieszka"],
            ["jadwidze", "jadwiga"],
            ["małgorzacie", "małgorzata"],
            ["marii", "maria"],
            ["patrycji", "patrycja"],
            ["jerzego", "jerzy"],
            ["antoniemu", "antoni"],
            ["aleksandrze", "aleksander"],
            ["kasiu", "kasia"],
        ];
        for (const [form, lemma] of cases) {
            expect(lemmaCandidates(form, false), form).toContain(lemma);
        }
    });

    test("surnames reduce to their nominative, plurals included", () => {
        const cases: ReadonlyArray<readonly [string, string]> = [
            ["kowalskiego", "kowalski"],
            ["kowalskiemu", "kowalski"],
            ["kowalskim", "kowalski"],
            ["kowalskiej", "kowalska"],
            ["kowalską", "kowalska"],
            ["zawadzkiego", "zawadzki"],
            ["nowaka", "nowak"],
            ["nowakowi", "nowak"],
            ["nowakiem", "nowak"],
            ["wójcika", "wójcik"],
            ["kowalczykiem", "kowalczyk"],
            ["wróbla", "wróbel"],
            ["mroza", "mróz"],
            ["kowalscy", "kowalski"],
            ["nowakowie", "nowak"],
        ];
        for (const [form, lemma] of cases) {
            expect(lemmaCandidates(form, true), form).toContain(lemma);
        }
    });

    // "-kie" is an adjective's ending ("Polskie", "Brzeskie"); a name in -ka takes "-ce" there.
    test("an adjective's -kie is not read as a surname's locative", () => {
        expect(lemmaCandidates("brzeskie", true)).not.toContain("brzeska");
    });
});

describe("first name and surname", () => {
    test("a pair is one span, in either order", () => {
        expect(names("Umowę podpisał Jan Kowalski.")).toEqual(["Jan Kowalski"]);
        expect(names("Lista: Kowalski Jan, Nowak Anna")).toEqual(["Kowalski Jan", "Nowak Anna"]);
    });

    test("inflected pairs and double-barrelled surnames", () => {
        expect(names("Wczoraj rozmawiałem z Markiem Nowakiem o projekcie.")).toEqual(["Markiem Nowakiem"]);
        expect(names("Przekaż to Annie Nowak-Kowalskiej.")).toEqual(["Annie Nowak-Kowalskiej"]);
        expect(names("Spotkanie z Katarzyną Wiśniewską i Pawłem Wójcikiem.")).toEqual(["Katarzyną Wiśniewską", "Pawłem Wójcikiem"]);
    });

    test("an unambiguous first name takes any capitalized word after it as the surname", () => {
        expect(names("Zadzwonił Grzegorz Brzęczyszczykiewicz.")).toEqual(["Grzegorz Brzęczyszczykiewicz"]);
        expect(names("Report by Jennifer Okafor attached.")).toEqual(["Jennifer Okafor"]);
    });

    test("English names", () => {
        expect(names("Yesterday John Smith sent the report to Sarah Johnson.")).toEqual(["John Smith", "Sarah Johnson"]);
    });

    // Will, Mark, Max are words; beside a listed surname they are names, beside another word they are not.
    test("a first name that is also a word needs a real surname", () => {
        expect(names("Will Smith starred in it.")).toEqual(["Will Smith"]);
        expect(names("Mark Johnson replied.")).toEqual(["Mark Johnson"]);
        expect(names("Max Price is 100.")).toEqual([]);
        expect(names("Will this work? Mark as read. Grace period ends in May.")).toEqual([]);
    });
});

describe("titles", () => {
    test("an honorific makes any capitalized word a person, without the title in the span", () => {
        expect(names("Pan Wilk przyszedł.")).toEqual(["Wilk"]);
        expect(names("Rozmawiałem z panią Różą.")).toEqual(["Różą"]);
        expect(names("dr hab. inż. Jan Kowalski, prof. Nowak, mgr Zając")).toEqual(["Jan Kowalski", "Nowak", "Zając"]);
        expect(names("Mr. Darcy and Mrs. Bennet")).toEqual(["Darcy", "Bennet"]);
    });

    test("an office or relation counts only before a word the lists know", () => {
        expect(names("prezes Kowalski i kolega Marek")).toEqual(["Kowalski", "Marek"]);
        expect(names("Identyfikator klienta Google")).toEqual([]);
    });

    // A full word with a dot after it ended a sentence; only abbreviations carry dots.
    test("a sentence that ends on a title word does not announce the next sentence", () => {
        expect(names("To zadanie dla pana. Szczególne zasługi ma zespół.")).toEqual([]);
        expect(names("the other red. Mr. Wickham said")).toEqual(["Wickham"]);
    });
});

describe("standalone names", () => {
    test("an unambiguous first name alone, in any form", () => {
        expect(names("Spotkałem wczoraj Zbigniewa.")).toEqual(["Zbigniewa"]);
        expect(names("Małgorzata napisała, że Grzegorz będzie później.")).toEqual(["Małgorzata", "Grzegorz"]);
        expect(names("Cześć, tu Kasia!")).toEqual(["Kasia"]);
    });

    test("a surname alone counts only with a surname's shape and a place in the register", () => {
        expect(names("Dokument przygotował Wiśniewski.")).toEqual(["Wiśniewski"]);
        expect(names("Zapytaj Kowalskiej.")).toEqual(["Kowalskiej"]);
        expect(names("Nowak przyszedł.")).toEqual([]);
    });

    test("ordinary words that are also names need context", () => {
        expect(names("Róża kwitnie w ogrodzie. Wilk i Lis to zwierzęta.")).toEqual([]);
        expect(names("Mają nadzieję. Inna sprawa. Kim jesteś?")).toEqual([]);
    });

    test("adjectives of places and institutions are not surnames", () => {
        expect(names("Uniwersytet Warszawski i Bank Polski")).toEqual([]);
        expect(names("Mieszka przy ulicy Grodzkiej, obok placu Jana Pawła.")).toEqual([]);
    });

    test("a heading in title case is not a name", () => {
        expect(names("Adam Optimizer Configuration Guide")).toEqual([]);
    });

    test("month names and volumes next to numbers are dates", () => {
        expect(names("Date: Mon Jan 5 14:02:11 2026")).toEqual([]);
        expect(names("Tom 2, ul. 3 Maja")).toEqual([]);
    });
});

describe("context that says a value is a person", () => {
    test("a person's field accepts even an ambiguous name", () => {
        expect(names('{"lastName": "Wilk", "nick": "Wilk"}')).toEqual(["Wilk"]);
        expect(names("author = Grace Lis")).toEqual(["Grace Lis"]);
    });

    // Sheets, products and builds have names too, so a bare "name" field vouches only for a name no word shares.
    test("a bare name field takes only an unambiguous name", () => {
        expect(names("name: Grace Kowalska")).toEqual(["Grace Kowalska"]);
        expect(names('{"name": "Data", "rows": 3}')).toEqual([]);
        expect(names('{"name": "Max Size"}')).toEqual([]);
        expect(names('{"productName": "Intentic"}')).toEqual([]);
    });

    test("mail and git headers, display names, greetings and signatures", () => {
        expect(names("Author: Jan Kowalski <jan@kowalski.pl>")).toEqual(["Jan Kowalski"]);
        expect(names("Mark Brown <mark@brown.dev>")).toEqual(["Mark Brown"]);
        expect(names("Hi Mark, thanks!")).toEqual(["Mark"]);
        expect(names("Dzięki za info.\nPozdrawiam,\nRóża")).toEqual(["Róża"]);
    });
});

describe("data-shaped text", () => {
    // A row keeps its columns: each cell is its own span, so the masked row still splits the same way.
    test("a sqlite row reports first name and surname as separate cells", () => {
        expect(names("1|Jan|Kowalski|85010112345")).toEqual(["Jan", "Kowalski"]);
    });

    test("CSV and TSV rows, quoted or not", () => {
        expect(names("id,imie,nazwisko\n1,Anna,Nowak\n2,Piotr,Zieliński")).toEqual(["Anna", "Nowak", "Piotr", "Zieliński"]);
        expect(names('"3","Ewa","Lewandowska"')).toEqual(["Ewa", "Lewandowska"]);
        expect(names("4\tTomasz\tWójcik")).toEqual(["Tomasz", "Wójcik"]);
    });

    test("a city in the next cell is not taken for a surname", () => {
        expect(names("Anna,Warszawa,2024")).toEqual(["Anna"]);
    });

    test("an upper-case row counts, an upper-case sentence of code does not", () => {
        expect(names("JAN,KOWALSKI,85010112345")).toEqual(["JAN", "KOWALSKI"]);
        expect(names("SELECT NAME FROM USERS WHERE MAX > 5")).toEqual([]);
    });

    test("JSON values", () => {
        expect(names('[{"first": "Jan", "last": "Kowalski"}, {"author": "Anna Maria Wiśniewska"}]')).toEqual([
            "Jan",
            "Kowalski",
            "Anna Maria Wiśniewska",
        ]);
    });
});

describe("text that is not prose", () => {
    test("identifiers, paths and URLs keep their capitalized words", () => {
        for (const text of [
            "const user = getAnna();",
            "obj.Anna = 1",
            "Anna.txt",
            "/home/Anna/Desktop",
            "C:\\Users\\Anna\\Documents",
            "https://example.com/users/Anna/Kowalska",
            "Anna_Kowalska",
            "AnnaKowalska",
            "--Anna",
            "@Anna",
            "<Anna>",
            "Anna::new()",
            "Don't stop.",
        ]) {
            expect(names(text), text).toEqual([]);
        }
    });

    test("in a line of code a lone first name counts only as a quoted value", () => {
        expect(names("import { Adam } from 'torch';")).toEqual([]);
        expect(names('const author = "Zbigniew";')).toEqual(["Zbigniew"]);
        expect(names("optimizer = build(Adam)")).toEqual([]);
    });

    test("a sentence ending in a bracket or a semicolon is still prose", () => {
        expect(names("Zadzwoń do Zbigniewa (pilne)")).toEqual(["Zbigniewa"]);
        expect(names("1;Anna;Warszawa;")).toEqual(["Anna"]);
    });
});
