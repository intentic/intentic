import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { decodeProtectedHeader, importX509, jwtVerify } from "jose";
import { z } from "zod";
import { bodyOf, type Call, header, json, type Recorder, recorder } from "../core/http.testing.js";
import { OfficeRecords } from "../core/records.js";
import { party } from "../signatures/fixtures.testing.js";
import { edSettings, type EdSettings, ENVIRONMENTS } from "./system-login.js";
import { EdClient } from "./mailbox.js";
import { MessageSchema } from "./mailbox-schemas.js";
import { saveOpened, saveProofs, syncInbox } from "./deliveries.js";

const ADE = "AE:PL-12345-67890-ABCDE-12";
const pem = (label: string, der: ArrayBuffer | Uint8Array): string => `-----BEGIN ${label}-----\n${Buffer.from(new Uint8Array(der)).toString("base64").replaceAll(/.{64}/g, "$&\n")}\n-----END ${label}-----\n`;

let settings: EdSettings;
let otherKey: string;
let root: string;

beforeAll(async () => {
    const system = await party({ subject: [["2.5.4.3", "Example office system"]], serial: 77 });
    const other = await party({ subject: [["2.5.4.3", "Another system"]], serial: 78 });
    otherKey = pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", other.keys.privateKey));
    settings = edSettings({
        card: "skrzynka",
        environment: ENVIRONMENTS.INT.iam,
        ade: ADE,
        systemName: "EZD-URZAD",
        certificate: pem("CERTIFICATE", system.der),
        privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", system.keys.privateKey)),
    });
    root = await mkdtemp(join(tmpdir(), "e-urzad-ed-"));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

const clock = (): Date => new Date();
const StoredSchema = z.object({ attachments: z.array(z.object({ file: z.object({ file: z.string().optional() }) })) });
const TOKEN_PATH = "/auth/realms/EDOR/protocol/openid-connect/token";
const mailbox = (answer: (call: Call) => Response): Recorder => recorder((call) => (call.url.pathname === TOKEN_PATH ? json({ access_token: "system-token", expires_in: 300, scope: "system-attributes" }) : answer(call)));

describe("e-Doręczenia system login", () => {
    test("the INT environment resolves to the documented addresses", () => {
        expect(settings.environment).toBe("INT");
        expect(settings.uaUrl).toBe("https://uaapi-int-ow.poczta-polska.pl/api/v3");
        expect(settings.seUrl).toBe("https://int-ow.edoreczenia.gov.pl/api/se/v4");
        expect(settings.tokenUrl).toBe("https://int-ow.edoreczenia.gov.pl/auth/realms/EDOR/protocol/openid-connect/token");
        expect(settings.audience).toBe("https://int-ow.edoreczenia.gov.pl/auth/realms/EDOR");
        const production = edSettings({ card: "skrzynka", environment: "PROD", ade: ADE, systemName: "EZD-URZAD", certificate: settings.certificate, privateKey: settings.privateKey });
        expect(production.uaUrl).toBe("https://uaapi-ow.poczta-polska.pl/api/v3");
        expect(production.audience).toBe("https://ow.edoreczenia.gov.pl/auth/realms/EDOR");
    });

    test("the client assertion is an RS256 JWT for <ADE>.SYSTEM.<name>, signed by the system certificate's key", async () => {
        const { calls, fetcher } = mailbox(() => json({ messages: [], total: 0 }));
        await new EdClient(settings, fetcher, clock).test();
        const exchange = calls[0];
        expect(exchange?.url.searchParams.get("login_hint")).toBe(`ADE.${ADE}`);
        expect(exchange?.init?.redirect).toBe("error");
        const form = new URLSearchParams(String(exchange?.init?.body));
        expect(form.get("grant_type")).toBe("client_credentials");
        expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
        const assertion = form.get("client_assertion") ?? "";
        expect(decodeProtectedHeader(assertion)).toEqual({ alg: "RS256", typ: "JWT" });
        const verified = await jwtVerify(assertion, await importX509(settings.certificate, "RS256"), { audience: settings.audience, issuer: `${ADE}.SYSTEM.EZD-URZAD`, subject: `${ADE}.SYSTEM.EZD-URZAD` });
        expect(verified.payload.jti).toBeString();
        expect(header(calls[1], "authorization")).toBe("Bearer system-token");
    });

    test("a private key that is not the certificate's is refused before anything is sent", async () => {
        const { calls, fetcher } = mailbox(() => json({}));
        await expect(new EdClient({ ...settings, privateKey: otherKey }, fetcher, clock).test()).rejects.toThrow("does not belong to its certificate");
        expect(calls).toHaveLength(0);
    });
});

describe("e-Doręczenia mailbox", () => {
    test("the inbox is listed as metadata, by offset, keeping the ADE's colon in the path", async () => {
        const messages = (from: number, count: number) =>
            Array.from({ length: count }, (_, n) => ({ messageMetadata: { messageId: `m${from + n}`, subject: `Pismo ${from + n}`, from: { eDeliveryAddress: "AE:PL-00000-00000-AAAAA-00" }, timestamp: "2026-10-12T09:00:00Z" }, messageControlData: { status: "Doręczona", opened: false, messageType: "Message" } }));
        const { calls, fetcher } = mailbox((call) => {
            const offset = Number(call.url.searchParams.get("offset"));
            return json({ messages: offset === 0 ? messages(0, 100) : messages(100, 3), total: 103, resultSize: 100 });
        });
        const rows = await syncInbox(new EdClient(settings, fetcher, clock), new OfficeRecords(root, "skrzynka", "e-doreczenia"));
        expect(rows).toHaveLength(103);
        const lists = calls.filter((call) => call.url.pathname.endsWith("/messages"));
        expect(lists.map((call) => call.url.searchParams.get("offset"))).toEqual(["0", "100"]);
        expect(lists[0]?.url.searchParams.get("format")).toBe("metadata");
        expect(lists[0]?.url.pathname).toBe(`/api/v3/${ADE}/messages`);
    });

    test("an opened delivery is saved with its attachments, inline or downloaded, and marked in the records", async () => {
        const { calls, fetcher } = mailbox((call) => {
            if (call.url.pathname.endsWith("/attachments/download")) {
                return new Response("duży załącznik", { headers: { "content-type": "application/pdf" } });
            }
            return json([]);
        });
        const records = new OfficeRecords(root, "skrzynka", "e-doreczenia");
        const message = {
            messageMetadata: { messageId: "m1", subject: "Decyzja", from: { eDeliveryAddress: "AE:PL-00000-00000-AAAAA-00" } },
            messageControlData: { status: "Doręczona", opened: true, messageType: "Message" },
            attachments: [
                { order: 1, attachmentId: "a1", file: { fileMetadata: { fileId: "f1", filename: "decyzja.xml" }, file: Buffer.from("<decyzja/>").toString("base64") } },
                { order: 2, attachmentId: "a2", file: { fileMetadata: { fileId: "f2", filename: "../../zalacznik.pdf" } } },
            ],
        };
        const saved = await saveOpened(new EdClient(settings, fetcher, clock), records, "m1", MessageSchema.parse(message));
        expect(saved.attachments).toHaveLength(2);
        expect(await readFile(join(root, saved.attachments[0]?.path ?? ""), "utf8")).toBe("<decyzja/>");
        expect(saved.attachments[1]?.path).toStartWith(`${STATE_GROUP_DIR.records}/e-urzad/skrzynka/deliveries/m1/`);
        expect(saved.attachments[1]?.path).not.toContain("..");
        expect(bodyOf(calls.find((call) => call.url.pathname.endsWith("/attachments/download")))).toEqual({ messageId: "m1", attachmentId: "a2" });
        const stored = StoredSchema.parse(JSON.parse(await readFile(join(root, saved.message.path), "utf8")));
        expect(stored.attachments[0]?.file.file).toBeUndefined();
        expect((await records.snapshot()).deliveries.find((row) => row.id === "m1")?.saved).toBe(`${STATE_GROUP_DIR.records}/e-urzad/skrzynka/deliveries/m1`);
    });

    test("proofs are saved under their evidence type and listed for the view", async () => {
        const { calls, fetcher } = mailbox((call) => {
            if (call.url.pathname.endsWith("/evidences")) {
                return json({ evidences: [{ evidenceId: "e1", messageId: "m1", type: "E.1", eventDate: "2026-10-12T10:00:00Z" }, { evidenceId: "e2", messageId: "m1", type: "H.PN" }] });
            }
            return new Response("<dowod/>", { headers: { "content-type": "application/xml" } });
        });
        const records = new OfficeRecords(root, "skrzynka", "e-doreczenia");
        const proofs = await saveProofs(new EdClient(settings, fetcher, clock), records, "m1");
        expect(proofs.map((proof) => proof.type)).toEqual(["E.1", "H.PN"]);
        expect(proofs[0]?.path).toEndWith("proofs/m1/E.1-e1.xml");
        expect(calls.filter((call) => call.url.pathname.includes("/evidences/")).map((call) => call.url.pathname.split("/").slice(-2).join("/"))).toEqual(["purde/e1", "puh/e2"]);
        expect((await records.snapshot()).proofs.map((proof) => proof.evidenceId)).toEqual(["e1", "e2"]);
    });

    test("a BAE search always names this mailbox as the sender", async () => {
        const { calls, fetcher } = mailbox(() => json({ totalResults: 0, baeSearchResponses: [] }));
        await new EdClient(settings, fetcher, clock).searchAddresses({ officialIds: [{ id: "5250001009", referenceRegistry: "nip" }], senderEda: "AE:PL-SOMEONE-ELSE" });
        const search = calls.find((call) => call.url.pathname.endsWith("/search/bae_search"));
        expect(search?.url.origin).toBe("https://int-ow.edoreczenia.gov.pl");
        expect(bodyOf(search)).toEqual({ recipientEdasOnly: false, officialIds: [{ id: "5250001009", referenceRegistry: "nip" }], senderEda: ADE });
    });
});
