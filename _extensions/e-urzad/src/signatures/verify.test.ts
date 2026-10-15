import { peselOf } from "./certificate.js";
import { EXAMPLE_PESEL, type Pki, pki, signCms, signedPdf, signXadesDetached, signXadesEnveloped } from "./fixtures.testing.js";
import { pdfDate } from "./pdf.js";
import { NO_TRUST_LIST } from "./timestamp.js";
import { verifyBytes } from "./verify.js";

let parties: Pki;

beforeAll(async () => {
    parties = await pki();
});

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));
const verify = (name: string, file: Uint8Array, content?: { name: string; bytes: Uint8Array }) => verifyBytes({ name, bytes: file }, content, NO_TRUST_LIST);

describe("CAdES", () => {
    test("an enveloping signature verifies and reports the signer, the QC claims and an unchecked trust chain", async () => {
        const report = await verify("pismo.p7m", await signCms(bytes("treść pisma"), parties.signer, { signingTime: new Date("2026-10-01T10:00:00Z") }));
        const [signature] = report.signatures;
        expect(report.detected).toBe("CAdES");
        expect(signature?.format).toBe("CAdES");
        expect(signature?.integrity).toBe("valid");
        expect(signature?.signerBound).toBe(true);
        expect(signature?.signer?.subject).toContain("CN=Anna Przykładowa");
        expect(signature?.signer?.issuer).toContain("CN=Example Qualified CA");
        expect(signature?.signer?.pesel).toBe(EXAMPLE_PESEL);
        expect(signature?.signer?.qc).toMatchObject({ compliance: true, qscd: true, types: ["esign"] });
        expect(signature?.signer?.policies).toEqual(["QCP-n-qscd (0.4.0.194112.1.2)"]);
        expect(signature?.signingTime).toEqual({ value: "2026-10-01T10:00:00.000Z", source: "cms-signing-time" });
        expect(signature?.trust.status).toBe("not-checked");
        expect(signature?.trust.detail).toContain("trust chain not checked");
        expect(signature?.qualification).toStartWith("not established");
    });

    test("a detached signature verifies with its file, breaks on a changed file and is not judged without one", async () => {
        const content = bytes("oryginalny wniosek");
        const signature = await signCms(content, parties.signer, { detached: true });
        expect((await verify("wniosek.pdf.sig", signature, { name: "wniosek.pdf", bytes: content })).signatures[0]?.integrity).toBe("valid");
        const tampered = (await verify("wniosek.pdf.sig", signature, { name: "wniosek.pdf", bytes: bytes("zmieniony wniosek") })).signatures[0];
        expect(tampered?.integrity).toBe("invalid");
        expect(tampered?.integrityDetail).toContain("changed");
        const alone = (await verify("wniosek.pdf.sig", signature)).signatures[0];
        expect(alone?.integrity).toBe("not-checked");
        expect(alone?.integrityDetail).toContain("--content");
    });

    test("a certificate swapped in for the signer's does not verify", async () => {
        // The stranger shares the signer's issuer-less name and serial, so the signer identifier points at it.
        const swapped = await signCms(bytes("treść"), parties.signer, { carry: [parties.stranger] });
        const [signature] = (await verify("pismo.p7s", swapped)).signatures;
        expect(signature?.integrity).not.toBe("valid");
    });

    test("a signature time-stamp is checked against the signature value", async () => {
        const [signature] = (await verify("pismo.p7m", await signCms(bytes("treść"), parties.signer, { timestampBy: parties.tsa }))).signatures;
        expect(signature?.timestamps).toHaveLength(1);
        expect(signature?.timestamps[0]).toMatchObject({ kind: "signature-timestamp", integrity: "valid" });
        expect(signature?.timestamps[0]?.tsa).toContain("CN=Example TSA");
    });

    test("PEM and Base64 armour are read as the same signature", async () => {
        const der = await signCms(bytes("treść"), parties.signer);
        const pem = `-----BEGIN PKCS7-----\n${Buffer.from(der).toString("base64")}\n-----END PKCS7-----\n`;
        expect((await verify("pismo.sig", bytes(pem))).signatures[0]?.integrity).toBe("valid");
        expect((await verify("pismo.sig", bytes(Buffer.from(der).toString("base64")))).signatures[0]?.integrity).toBe("valid");
    });
});

describe("XAdES", () => {
    test("an enveloped signature verifies, binds its certificate and carries a signed signing time", async () => {
        const [signature] = (await verify("wniosek.xml", bytes(await signXadesEnveloped("<wniosek><tresc>Proszę o wydanie zaświadczenia</tresc></wniosek>", parties.signer)))).signatures;
        expect(signature?.format).toBe("XAdES");
        expect(signature?.integrity).toBe("valid");
        expect(signature?.signerBound).toBe(true);
        expect(signature?.signingTime?.source).toBe("xades-signing-time");
        expect(signature?.scope).toContain("the whole document (enveloped)");
        expect(signature?.signer?.qc.compliance).toBe(true);
        expect(signature?.trust.status).toBe("not-checked");
    });

    test("a changed document breaks the signature", async () => {
        const xml = await signXadesEnveloped("<wniosek><kwota>100</kwota></wniosek>", parties.signer);
        const [signature] = (await verify("wniosek.xades", bytes(xml.replace("<kwota>100</kwota>", "<kwota>900</kwota>")))).signatures;
        expect(signature?.integrity).toBe("invalid");
    });

    test("a detached signature needs its file and verifies over its exact bytes", async () => {
        const content = bytes("%PDF-1.7 a document signed outside");
        const xml = await signXadesDetached(content, "decyzja.pdf", parties.signer);
        expect((await verify("decyzja.pdf.xades", bytes(xml))).signatures[0]?.integrity).toBe("not-checked");
        expect((await verify("decyzja.pdf.xades", bytes(xml), { name: "decyzja.pdf", bytes: content })).signatures[0]?.integrity).toBe("valid");
        expect((await verify("decyzja.pdf.xades", bytes(xml), { name: "decyzja.pdf", bytes: bytes("%PDF-1.7 another document") })).signatures[0]?.integrity).toBe("invalid");
    });

    test("a KeyValue is never trusted over the named certificate", async () => {
        const xml = await signXadesEnveloped("<wniosek/>", parties.signer);
        const other = parties.stranger.base64;
        const swapped = xml.replace(parties.signer.base64, other);
        expect((await verify("wniosek.xml", bytes(swapped))).signatures[0]?.integrity).toBe("invalid");
    });

    test("a signature time-stamp over the canonical SignatureValue is verified", async () => {
        const xml = await signXadesEnveloped("<wniosek/>", parties.signer, { timestampBy: parties.tsa });
        const [signature] = (await verify("wniosek.xml", bytes(xml))).signatures;
        expect(signature?.integrity).toBe("valid");
        expect(signature?.timestamps[0]).toMatchObject({ kind: "signature-timestamp", integrity: "valid" });
    });

    test("DTDs are refused before parsing", async () => {
        const report = await verify("atak.xml", bytes('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'));
        expect(report.signatures).toHaveLength(0);
        expect(report.problem).toContain("DTD");
    });
});

describe("PAdES", () => {
    test("a signed PDF verifies over its whole byte range", async () => {
        const report = await verify("decyzja.pdf", await signedPdf(parties.signer, { signingTime: new Date("2026-10-13T12:00:00Z") }));
        const [signature] = report.signatures;
        expect(report.detected).toBe("PAdES");
        expect(signature?.format).toBe("PAdES");
        expect(signature?.integrity).toBe("valid");
        expect(signature?.scope).toContain("covers the whole file");
        expect(signature?.notes.join(" ")).toContain("ETSI.CAdES.detached");
    });

    test("a changed byte inside the signed range breaks it, bytes appended later are reported", async () => {
        const pdf = Buffer.from(await signedPdf(parties.signer));
        const tampered = Buffer.from(pdf.toString("latin1").replace("/MediaBox [0 0 200 200]", "/MediaBox [0 0 900 900]"), "latin1");
        expect((await verify("decyzja.pdf", new Uint8Array(tampered))).signatures[0]?.integrity).toBe("invalid");
        const appended = Buffer.concat([pdf, Buffer.from("\n% a later incremental update\n", "latin1")]);
        const [signature] = (await verify("decyzja.pdf", new Uint8Array(appended))).signatures;
        expect(signature?.integrity).toBe("valid");
        expect(signature?.scope).toContain("bytes were appended later");
    });

    test("a file cut short is a broken signature, not an unsigned PDF", async () => {
        const pdf = await signedPdf(parties.signer);
        const [signature] = (await verify("decyzja.pdf", pdf.subarray(0, pdf.byteLength - 10))).signatures;
        expect(signature?.integrity).toBe("invalid");
        expect(signature?.integrityDetail).toContain("past the end of the file");
    });

    test("the dictionary's /M date is read as an unsigned claim", () => {
        expect(pdfDate("<< /M (D:20261013120000+02'00') >>")).toEqual({ value: "2026-10-13T10:00:00.000Z", source: "pdf-dictionary" });
    });
});

describe("what is not a signature", () => {
    test("an unsupported or broken file is reported, never verified", async () => {
        expect((await verify("notatka.txt", bytes("zwykły tekst"))).problem).toContain("not a supported signature format");
        expect((await verify("pismo.p7s", bytes("garbage"))).signatures).toHaveLength(0);
        expect((await verify("pusty.pdf", bytes("%PDF-1.7\n%%EOF\n"))).problem).toContain("no signature");
        expect((await verify("bez.xml", bytes("<a/>"))).problem).toContain("no ds:Signature");
    });

    test("only a check-digit-valid national number is read as one", () => {
        expect(peselOf(`PNOPL-${EXAMPLE_PESEL}`)).toBe(EXAMPLE_PESEL);
        expect(peselOf("PNOPL-12345678901")).toBeUndefined();
        expect(peselOf("IDCPL-ABC123")).toBeUndefined();
    });
});
