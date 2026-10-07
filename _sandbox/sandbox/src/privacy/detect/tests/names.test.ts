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

    // A capitalized word nobody lists may be anything: a product, a heading, the next sentence.
    test("the surname must be a listed one or a surname's form, never just any capitalized word", () => {
        expect(names("Zadzwonił Grzegorz Brzęczyszczykiewicz.")).toEqual(["Grzegorz Brzęczyszczykiewicz"]);
        expect(names("Zadzwonił Zbigniew Brzęczyszczykiewicz.")).toEqual(["Zbigniew Brzęczyszczykiewicz"]);
        expect(names("Report by Jennifer Okafor attached.")).toEqual([]);
        expect(names("Natalia Restaurant opens at noon.")).toEqual([]);
    });

    // "Costa" is a coast and "Luna" the moon in half of Europe's languages: neither completes a name.
    test("a surname that is an ordinary word in some language does not complete a name", () => {
        expect(names("Umowę podpisali Anna Costa i Marek Luna.")).toEqual([]);
        expect(names("Lista: Costa, Anna; Luna, Marek")).toEqual([]);
        expect(names("Luna Kowalska przyszła.")).toEqual(["Luna Kowalska"]);
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

    test("an office or relation counts only before a surname no word or first name shares", () => {
        expect(names("prezes Kowalski i kolega Marek")).toEqual(["Kowalski"]);
        expect(names("Identyfikator klienta Google")).toEqual([]);
    });

    // A full word with a dot after it ended a sentence; only abbreviations carry dots.
    test("a sentence that ends on a title word does not announce the next sentence", () => {
        expect(names("To zadanie dla pana. Szczególne zasługi ma zespół.")).toEqual([]);
        expect(names("the other red. Mr. Wickham said")).toEqual(["Wickham"]);
    });
});

describe("a word alone", () => {
    // Nearly every name is a word in some language, a button's label or the start of a sentence.
    test("a first name alone is never masked, in any form", () => {
        expect(names("Spotkałem wczoraj Zbigniewa.")).toEqual([]);
        expect(names("Małgorzata napisała, że Grzegorz będzie później.")).toEqual([]);
        expect(names("Cześć, tu Kasia!")).toEqual([]);
    });

    test("nor is a surname alone, whatever its shape", () => {
        expect(names("Dokument przygotował Wiśniewski.")).toEqual([]);
        expect(names("Zapytaj Kowalskiej.")).toEqual([]);
        expect(names("Nowak przyszedł.")).toEqual([]);
    });

    // What the shield's own log showed masked: a list of single words, and tool descriptions that start with a verb.
    test("words that are names somewhere stay as they are on their own", () => {
        expect(names("False positives:\n- Mark\n- Any\n- Luna\n- Drop\n- Grace\nWe should never mask them.")).toEqual([]);
        expect(names('{"name":"mark_connected","description":"Mark an account as connected"}')).toEqual([]);
        expect(names('{"name":"browser_drop","description":"Drop files or MIME-typed data onto an element"}')).toEqual([]);
        expect(names("Luna, Costa, Tom i Adam to też słowa.")).toEqual([]);
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

    test("mail and git headers and display names take a full name", () => {
        expect(names("Author: Jan Kowalski <jan@kowalski.pl>")).toEqual(["Jan Kowalski"]);
        expect(names("Mark Brown <mark@brown.dev>")).toEqual(["Mark Brown"]);
        expect(names("From: Luna <mark@brown.dev>")).toEqual([]);
    });

    // What follows a greeting or closes a letter is as often a word as a name.
    test("a greeting or a signature vouches for nothing on its own", () => {
        expect(names("Hi Mark, thanks!")).toEqual([]);
        expect(names("Dzięki za info.\nPozdrawiam,\nRóża")).toEqual([]);
        expect(names("Hi Jan Kowalski, thanks!")).toEqual(["Jan Kowalski"]);
    });

    test("a field for a whole person takes a full name, not one word", () => {
        expect(names('{"owner": "Luna", "author": "Grace"}')).toEqual([]);
        expect(names('{"owner": "Luna Kowalska"}')).toEqual(["Luna Kowalska"]);
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

    test("a city in the next cell is not taken for a surname, and a first name alone in a row is no find", () => {
        expect(names("Anna,Warszawa,2024")).toEqual([]);
    });

    test("an upper-case row counts, an upper-case sentence of code does not", () => {
        expect(names("JAN,KOWALSKI,85010112345")).toEqual(["JAN", "KOWALSKI"]);
        expect(names("SELECT NAME FROM USERS WHERE MAX > 5")).toEqual([]);
    });

    test("JSON values", () => {
        expect(names('[{"firstName": "Jan", "lastName": "Kowalski"}, {"author": "Anna Maria Wiśniewska"}]')).toEqual([
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

    test("in a line of code a field names a person only as a quoted value", () => {
        expect(names("import { Adam } from 'torch';")).toEqual([]);
        expect(names('const lastName = "Kowalski";')).toEqual(["Kowalski"]);
        expect(names("const lastName = surname;")).toEqual([]);
        expect(names("optimizer = build(Adam)")).toEqual([]);
    });

    test("a sentence ending in a bracket or a semicolon is still prose", () => {
        expect(names("Zadzwoń do Jan Kowalski (pilne)")).toEqual(["Jan Kowalski"]);
        expect(names("1;Anna;Nowak;Warszawa;")).toEqual(["Anna", "Nowak"]);
    });
});

describe("words that are names only sometimes", () => {
    // The surname register holds English words ("Drop", "Just", "Block"), and a task title or a commit subject starts
    // with one capitalized.
    test("a register surname that is an English word is no name at the start of a title or a field's sentence", () => {
        for (const text of [
            "Drop offset from route component and fix test",
            '{"name": "Drop offset from route component and fix test"}',
            '{"title": "Just checking the build", "user": "Block until ready"}',
            "Thanks\nDrop the cache before the next run",
        ]) {
            expect(names(text), text).toEqual([]);
        }
    });

    test("programming languages, tools and placeholders named like people stay as they are", () => {
        expect(names("We rewrote it in Julia, then Ada, and the site is built with Hugo.")).toEqual([]);
        expect(names("Textures come from Poly Haven.")).toEqual([]);
        expect(names('{"name": "Job Listings", "machine_name": "Mac mini"}')).toEqual([]);
        expect(names("Alice Example signs in; Manuel Gateway answers")).toEqual([]);
    });

    test("an ambiguous name still counts beside a surname or in a person's field", () => {
        expect(names("Maya Kowalska przyszła.")).toEqual(["Maya Kowalska"]);
        expect(names('{"lastName": "Drop"}')).toEqual(["Drop"]);
    });
});

describe("context that says no person is named", () => {
    test("a display name before a bot's, a team's or a reserved address is not a person", () => {
        for (const text of [
            "Co-authored-by: Claude Opus 4.5 <noreply@anthropic.com>",
            "Author: Release Bot <ci@intentic.dev>",
            "From: Support Team <support@shop.pl>",
            "Signed-off-by: Maria Test <maria@example.test>",
        ]) {
            expect(names(text), text).toEqual([]);
        }
        expect(names("Author: Maria Kowalska <maria.kowalska@intentic.dev>")).toEqual(["Maria Kowalska"]);
    });

    test("a field in a line of code names a person only as a string", () => {
        expect(names("    def acquire(self, owner: Any, relay: Any) -> None:")).toEqual([]);
        expect(names('const author = "Ewa Lewandowska";')).toEqual(["Ewa Lewandowska"]);
    });

    test("month abbreviations listed together are months", () => {
        expect(names("const months = ['Jan','Feb','Mar','Apr','May'];")).toEqual([]);
        expect(names('{"headers": ["Product", "Jan", "Feb", "Mar"]}')).toEqual([]);
    });

    test("a markdown heading capitalizes every word, so a first name there needs a real surname too", () => {
        expect(names("## Victoria Charts")).toEqual([]);
        expect(names("## Anna Kowalska")).toEqual(["Anna Kowalska"]);
    });
});
