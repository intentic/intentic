import { type Party, party, type Pki, pki, signCms, trustedListXml } from "../fixtures.testing.js";
import { verifyBytes } from "../verify.js";
import { trustListEvaluator } from "./evaluate.js";
import { LOTL_URL, refreshTrustedLists, type TrustCache } from "./lists.js";
import { SERVICE_TYPE } from "./tsl.js";

const PL_LOCATION = "https://tsl.example.test/PL_TSL.xml";

let parties: Pki;
let lotlSigner: Party;
let plSigner: Party;
let impostor: Party;

beforeAll(async () => {
    parties = await pki();
    lotlSigner = await party({ subject: [["2.5.4.3", "Example LOTL signer"]], serial: 5001 });
    plSigner = await party({ subject: [["2.5.4.3", "Example PL list signer"]], serial: 5002 });
    impostor = await party({ subject: [["2.5.4.3", "Example PL list signer"]], serial: 5002 });
});

const lists = async (plListSigner: Party = plSigner): Promise<Map<string, string>> => {
    const lotl = await trustedListXml("EU", [], [
        { territory: "EU", location: LOTL_URL, signer: lotlSigner },
        { territory: "PL", location: PL_LOCATION, signer: plSigner },
    ], lotlSigner);
    const pl = await trustedListXml("PL", [
        { type: SERVICE_TYPE.caQualified, name: "Example Qualified CA", certificate: parties.root },
        { type: SERVICE_TYPE.timestampQualified, name: "Example TSA", certificate: parties.tsa },
    ], [], plListSigner);
    return new Map([[LOTL_URL, lotl], [PL_LOCATION, pl]]);
};

const fetcherOf = (documents: ReadonlyMap<string, string>) => (url: string): Promise<Response> => {
    const body = documents.get(url);
    return Promise.resolve(body === undefined ? new Response("missing", { status: 404 }) : new Response(body));
};

const refreshed = async (): Promise<TrustCache> => (await refreshTrustedLists({ fetcher: fetcherOf(await lists()), territories: ["PL"], now: new Date("2026-10-13T00:00:00Z") })).cache;

describe("the EU trusted lists", () => {
    test("the LOTL and the Polish list are fetched, their signatures checked, and their services cached", async () => {
        const cache = await refreshed();
        expect(cache.lotl.territory).toBe("EU");
        expect(cache.lists).toHaveLength(1);
        expect(cache.lists[0]?.territory).toBe("PL");
        expect(cache.lists[0]?.services.map((service) => service.name)).toEqual(["Example Qualified CA", "Example TSA"]);
        expect(cache.lists[0]?.services[0]?.history[0]?.status).toBe("http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted");
    });

    test("a list signed by anyone but the certificate the LOTL names for it is refused", async () => {
        await expect(refreshTrustedLists({ fetcher: fetcherOf(await lists(impostor)), territories: ["PL"] })).rejects.toThrow("not among the certificates");
    });

    test("a list changed after signing is refused", async () => {
        const documents = await lists();
        documents.set(PL_LOCATION, (documents.get(PL_LOCATION) ?? "").replace("Example Qualified CA", "Forged Qualified CA"));
        await expect(refreshTrustedLists({ fetcher: fetcherOf(documents), territories: ["PL"] })).rejects.toThrow("does not verify");
    });

    test("a territory the LOTL does not point to is reported, and the others are still cached", async () => {
        await expect(refreshTrustedLists({ fetcher: fetcherOf(await lists()), territories: ["XX"] })).rejects.toThrow("names no XML trusted list for XX");
        const { cache, failed } = await refreshTrustedLists({ fetcher: fetcherOf(await lists()), territories: ["PL", "XX"] });
        expect(cache.lists.map((list) => list.territory)).toEqual(["PL"]);
        expect(failed).toEqual([{ territory: "XX", error: "the list of trusted lists names no XML trusted list for XX" }]);
    });

    test("the list of lists itself is never taken over plain HTTP", async () => {
        await expect(refreshTrustedLists({ fetcher: fetcherOf(await lists()), territories: ["PL"], lotlUrl: "http://ec.europa.eu/tools/lotl/eu-lotl.xml" })).rejects.toThrow("refusing a trusted list over http:");
    });
});

describe("trust through the cached lists", () => {
    test("a signer under a granted CA/QC service is anchored, and the qualification is indicated but never confirmed", async () => {
        const report = await verifyBytes({ name: "pismo.p7m", bytes: await signCms(new Uint8Array(Buffer.from("treść")), parties.signer, { timestampBy: parties.tsa }) }, undefined, trustListEvaluator(await refreshed()));
        const [signature] = report.signatures;
        expect(signature?.integrity).toBe("valid");
        expect(signature?.trust.status).toBe("anchored");
        expect(signature?.trust.service?.name).toBe("Example Qualified CA");
        expect(signature?.trust.revocation).toBe("not-checked");
        expect(signature?.qualification).toStartWith("indicated, not confirmed");
        expect(signature?.timestamps[0]?.trust.status).toBe("anchored");
        expect(signature?.timestamps[0]?.trust.service?.type).toBe(SERVICE_TYPE.timestampQualified);
    });

    test("a self-signed certificate is not anchored", async () => {
        const report = await verifyBytes({ name: "pismo.p7m", bytes: await signCms(new Uint8Array(Buffer.from("treść")), parties.stranger) }, undefined, trustListEvaluator(await refreshed()));
        expect(report.signatures[0]?.trust.status).toBe("not-anchored");
        expect(report.signatures[0]?.qualification).toStartWith("not established");
    });

    // PKI.js answers these two with different codes (a dead end at an issuer it cannot find, a path that reaches no anchor).
    test("a signer under a CA on no list is not anchored, nor is a self-signed one", async () => {
        const evaluator = trustListEvaluator(await refreshed());
        const unlisted = await party({ subject: [["2.5.4.3", "Unlisted CA"]], serial: 7000, ca: true });
        const orphan = await party({ subject: [["2.5.4.3", "Orphan"]], serial: 7001, issuer: unlisted });
        expect((await evaluator.evaluate(orphan.certificate, [], undefined, "signer")).status).toBe("not-anchored");
        expect((await evaluator.evaluate(parties.stranger.certificate, [], undefined, "signer")).status).toBe("not-anchored");
    });

    test("a path to a listed CA that fails a check on the way is chain-invalid, with PKI.js's reason", async () => {
        const facts = await trustListEvaluator(await refreshed()).evaluate(parties.signer.certificate, [], new Date("2000-01-01T00:00:00Z"), "signer");
        expect(facts.status).toBe("chain-invalid");
        expect(facts.detail).toStartWith("the path to the trusted list does not validate: ");
    });

    test("no cache means trust is not checked, said in those words", async () => {
        const report = await verifyBytes({ name: "pismo.p7m", bytes: await signCms(new Uint8Array(Buffer.from("treść")), parties.signer) }, undefined, trustListEvaluator(undefined));
        expect(report.signatures[0]?.trust.detail).toContain("trust chain not checked");
    });
});
