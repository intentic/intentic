import { createHash } from "node:crypto";
import { z } from "zod";
import { bodyOf, type Call, header, json, type Recorder, recorder } from "../core/http.testing.js";
import { clientIdFor, type EzdSettings, keyHash, requestTime } from "./key-exchange.js";
import { EzdClient } from "./integrator.js";
import { jrwaOf } from "./integrator-schemas.js";

const settings: EzdSettings = {
    card: "urzad",
    apiUrl: "https://integrator-api.example.test",
    ssoUrl: "https://sso-idp.example.test",
    webHost: "https://ezdrp-web.example.test/",
    subjectId: "84639066b68d4115805b804973da459a",
    keyId: "8e6f01849bf242fe8c15d83e5e4e7d11",
    apiKey: "synthetic-key-value",
    positionId: "stanowisko-1",
};

const clock = (): Date => new Date("2026-10-13T08:30:15.123Z");
const tokenAnswer = (): Response => json({ access_token: "token-1", expires_in: 3600, token_type: "Bearer", scope: "api.ezdrp.gov.pl" });

// Every SSO token request answers a token; everything else answers through the test's own function.
const office = (answer: (call: Call) => Response): Recorder => recorder((call) => (call.url.pathname === "/connect/token" ? tokenAnswer() : answer(call)));

const PageNumberSchema = z.object({ pageInfo: z.object({ pageNumber: z.number() }) });

describe("EZD RP API-key exchange", () => {
    test("posts the documented form: hashed key, hashed web host, whole-second request time, no redirects", async () => {
        const { calls, fetcher } = office(() => json({ lista: [], pageInfo: { pageNumber: 0, pageSize: 25, indexStart: 0, indexEnd: 0, isNextPageExists: false } }));
        await new EzdClient({ ...settings, userId: "uzytkownik-7" }, fetcher, clock).tasks();
        const exchange = calls[0];
        expect(exchange?.url.href).toBe("https://sso-idp.example.test/connect/token");
        expect(exchange?.init?.redirect).toBe("error");
        const form = new URLSearchParams(String(exchange?.init?.body));
        expect(form.get("grant_type")).toBe("api_credentials");
        expect(form.get("scope")).toBe("api.ezdrp.gov.pl");
        expect(form.get("pid")).toBe(settings.subjectId);
        expect(form.get("aki")).toBe(settings.keyId);
        expect(form.get("rt")).toBe("2026-10-13T08:30:15Z");
        expect(form.get("akh")).toBe(createHash("sha256").update("2026-10-13T08:30:15Zsynthetic-key-value").digest("base64"));
        expect(form.get("client_id")).toBe(`api_${createHash("sha256").update("ezdrp-web.example.test").digest("base64")}`);
        expect(form.get("uid")).toBe("uzytkownik-7");
    });

    test("the helpers match the manual's construction", () => {
        expect(requestTime(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02T03:04:05Z");
        expect(keyHash("t", "k")).toBe(createHash("sha256").update("tk").digest("base64"));
        expect(clientIdFor("ezdrp-web.int2.ezdrp.gov.pl")).toBe(clientIdFor("https://EZDRP-web.int2.ezdrp.gov.pl/"));
    });
});

describe("EZD RP reads", () => {
    test("every call carries the bearer and the Sid, and one token serves them all", async () => {
        const { calls, fetcher } = office(() => json({ idSprawa: "s1", tytul: "Sprawa" }));
        const client = new EzdClient(settings, fetcher, clock);
        await client.case("s1");
        await client.case("s1");
        expect(calls.filter((call) => call.url.pathname === "/connect/token")).toHaveLength(1);
        expect(calls[1]?.url.pathname).toBe("/ezdrp/integrator/v2/sprawy/s1");
        expect(header(calls[1], "authorization")).toBe("Bearer token-1");
        expect(header(calls[1], "sid")).toBe("stanowisko-1");
    });

    test("without a Sid on the card, the user's current position is looked up once", async () => {
        const { calls, fetcher } = office((call) => (call.url.pathname.endsWith("/struktura/uzytkownik") ? json({ imie: "Jan", idStanowisko: "stanowisko-9", listaStanowisk: [] }) : json({})));
        const client = new EzdClient({ ...settings, positionId: undefined }, fetcher, clock);
        await client.document("d1");
        await client.document("d2");
        expect(calls.filter((call) => call.url.pathname.endsWith("/struktura/uzytkownik"))).toHaveLength(1);
        expect(header(calls.at(-1), "sid")).toBe("stanowisko-9");
    });

    test("case search walks pageInfo 25 at a time and defaults to cases in progress", async () => {
        const item = (n: number) => ({ idSprawa: `s${n}`, tytul: `Sprawa ${n}`, znak: `OR.0012.${n}.2026`, status: "W toku", terminZalatwienia: "2026-11-01" });
        const { calls, fetcher } = office((call) => {
            const page = PageNumberSchema.parse(bodyOf(call)).pageInfo.pageNumber;
            const rows = page === 0 ? Array.from({ length: 25 }, (_, n) => item(n)) : [item(25)];
            return json({ lista: rows, pageInfo: { pageNumber: page, pageSize: 25, indexStart: 0, indexEnd: 0, isNextPageExists: page === 0 } });
        });
        const cases = await new EzdClient(settings, fetcher, clock).cases({ jrwa: "0012" });
        expect(cases).toHaveLength(26);
        expect(cases[3]).toEqual({ id: "s3", sign: "OR.0012.3.2026", title: "Sprawa 3", status: "W toku", jrwa: "0012", deadline: "2026-11-01", started: undefined });
        const searches = calls.filter((call) => call.url.pathname.endsWith("/sprawy/_search"));
        expect(searches.map((call) => bodyOf(call))).toEqual([
            { status: 1, jrwa: "0012", pageInfo: { pageNumber: 0, pageSize: 25 } },
            { status: 1, jrwa: "0012", pageInfo: { pageNumber: 1, pageSize: 25 } },
        ]);
    });

    test("tasks page by query and stop at a short page", async () => {
        const { calls, fetcher } = office((call) =>
            json({ lista: [{ idZadanie: "z1", idObieg: "o1", dataOtrzymania: "2026-10-12T10:00:00", statusOpis: "Niepodjęte", tytulDokumentu: "Wniosek", numerSprawy: null, tytulSprawy: null, numerRpw: "RPW/7/2026" }], pageInfo: { pageNumber: Number(call.url.searchParams.get("page")), pageSize: 25, indexStart: 0, indexEnd: 0 } }),
        );
        const tasks = await new EzdClient(settings, fetcher, clock).tasks();
        expect(tasks).toEqual([{ id: "z1", flowId: "o1", received: "2026-10-12T10:00:00", status: "Niepodjęte", documentTitle: "Wniosek", caseSign: undefined, caseTitle: undefined, registryNumber: "RPW/7/2026" }]);
        expect(calls.filter((call) => call.url.pathname.endsWith("/obiegi")).map((call) => call.url.searchParams.get("page"))).toEqual(["0"]);
    });

    test("document search refuses fewer than the two criteria EZD requires, before any call", async () => {
        const { calls, fetcher } = office(() => json({}));
        await expect(new EzdClient(settings, fetcher, clock).searchDocuments({ tytul: "wniosek" })).rejects.toThrow("at least two criteria");
        expect(calls).toHaveLength(0);
    });

    test("a download link off this instance is refused; one on its file repository is fetched, with credentials only after a 401", async () => {
        const foreign = office((call) => (call.url.pathname.endsWith("/link") ? json({ link: "https://stranger.example.org/file" }) : json({})));
        await expect(new EzdClient(settings, foreign.fetcher, clock).download("d1", "d1.bin")).rejects.toThrow("outside this instance");
        expect(foreign.calls.some((call) => call.url.host === "stranger.example.org")).toBe(false);
        let attempts = 0;
        const own = office((call) => {
            if (call.url.pathname.endsWith("/link")) {
                return json({ link: "https://filerepo-api.example.test/pobierz/abc" });
            }
            attempts += 1;
            return attempts === 1 ? new Response("", { status: 401 }) : new Response("treść", { headers: { "content-disposition": 'attachment; filename="pismo.pdf"' } });
        });
        const downloaded = await new EzdClient(settings, own.fetcher, clock).download("d1", "d1.bin");
        expect(downloaded.name).toBe("pismo.pdf");
        const fileCalls = own.calls.filter((call) => call.url.host === "filerepo-api.example.test");
        expect(header(fileCalls[0], "authorization")).toBeNull();
        expect(header(fileCalls[1], "authorization")).toBe("Bearer token-1");
    });

    test("an office error is reported with its problem title, an SSO error without its body", async () => {
        const problem = office(() => json({ title: "Błąd walidacji zapytania", detail: "Wypełnij minimum dwa kryteria wyszukiwania." }, 400));
        await expect(new EzdClient(settings, problem.fetcher, clock).case("s1")).rejects.toThrow("Wypełnij minimum dwa kryteria");
        const refused = (url: string): Promise<Response> => Promise.resolve(new URL(url).pathname === "/connect/token" ? json({ error: "invalid_grant", echoed: settings.apiKey }, 400) : json({}));
        const error = await new EzdClient(settings, refused, clock).case("s1").catch((cause: unknown) => cause);
        expect(String(error)).toContain("HTTP 400");
        expect(String(error)).not.toContain(settings.apiKey);
    });
});

describe("JRWA from the case sign", () => {
    test("reads unit.JRWA.number.year and nothing else", () => {
        expect(jrwaOf("SSPASI.000.3.2025")).toBe("000");
        expect(jrwaOf("OR.KSA.0012.15.2026")).toBe("0012");
        expect(jrwaOf("bez-znaku")).toBeUndefined();
    });
});
