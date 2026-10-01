import { detectPersonalData } from "../detect.js";

const addresses = (text: string): string[] => detectPersonalData(text, { classes: new Set(["address"]) }).map((span) => span.value);

describe("street addresses", () => {
    test("a street with its house number, flat and postal code is one address", () => {
        expect(addresses("Mieszka przy ul. Marszałkowskiej 12/4 m. 5, 00-001 Warszawa, od roku.")).toEqual([
            "ul. Marszałkowskiej 12/4 m. 5, 00-001 Warszawa",
        ]);
    });

    test("every street marker, in any case", () => {
        for (const address of [
            "ul. Długa 5",
            "UL. Długa 5",
            "ulica Długa 5A",
            "al. Jerozolimskie 123",
            "Aleje Jerozolimskie 123/45",
            "pl. Grunwaldzki 1",
            "plac Bankowy 3",
            "os. Tysiąclecia 12 m 7",
            "osiedle Kościuszkowskie 4 lok. 2",
        ]) {
            expect(addresses(`adres: ${address}, Polska`), address).toEqual([address]);
        }
    });

    test("street names with ranks, day numbers, regnal numbers and double surnames", () => {
        for (const address of [
            "ul. gen. Władysława Andersa 15",
            "ul. 3 Maja 2",
            "al. Jana Pawła II 61",
            "ul. Marii Skłodowskiej-Curie 9/11",
            "ul. ks. Jerzego Popiełuszki 4",
        ]) {
            expect(addresses(address), address).toEqual([address]);
        }
    });

    test("a street named without a number is a place, not where someone lives", () => {
        expect(addresses("korek na ul. Marszałkowskiej od rana")).toEqual([]);
        expect(addresses("ulica długa 5")).toEqual([]);
    });

    test("a citation's et al. is not an avenue", () => {
        expect(addresses("Kowalski et al. Nature 12 (2020)")).toEqual([]);
    });
});

describe("postal codes", () => {
    test("a postal code with its place is an address on its own", () => {
        expect(addresses("Wysyłka: 61-001 Poznań")).toEqual(["61-001 Poznań"]);
        expect(addresses("30-001 Kraków, Polska")).toEqual(["30-001 Kraków"]);
        expect(addresses("43-300 Bielsko-Biała")).toEqual(["43-300 Bielsko-Biała"]);
        expect(addresses("65-001 Zielona Góra")).toEqual(["65-001 Zielona Góra"]);
        expect(addresses("00-950 WARSZAWA")).toEqual(["00-950 WARSZAWA"]);
    });

    test("ranges, dates and units that share the shape are not addresses", () => {
        for (const text of ["10-100 Users per seat", "plan 10-100 Users", "20-200 Hz", "2024-01-15 Monday", "10-100 MB", "99-999 items"]) {
            expect(addresses(text), text).toEqual([]);
        }
    });
});
