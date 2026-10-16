import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovedAction } from "@intentic/extension-api";
import { type FakeExtension, fakeExtensionApi } from "@intentic/extension-api/testing";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { z } from "zod";
import manifest from "../../intentic-extension.json";
import { proposeAttach, proposeSend } from "../actions.js";
import { edFromConfig } from "../core/cards.js";
import { ActionGuard, approvalsDir, mediaDir, OPERATION_FILE } from "../core/guard.js";
import { type Call, bodyOf, json, recorder } from "../core/http.testing.js";
import { recordsDir } from "../core/records.js";
import type { EzdSettings } from "../ezd/key-exchange.js";
import { party } from "../signatures/fixtures.testing.js";
import { ATTEMPTS_FILE } from "./perform.js";
import { activateServer } from "./server.js";

// The one place an office act is carried out: the backend, handed an approved item the way the daemon's approvals
// executor hands it over (after it matched the person's yes and spent it). The office is a recorder and the daemon a
// fake that answers the card's connection, so each test says exactly what reached the office, and how often.

const CONFIG = { provider: "ezd-rp", apiUrl: "https://integrator-api.example.test", ssoUrl: "https://sso-idp.example.test", webHost: "ezdrp-web.example.test", subjectId: "pid", keyId: "aki", apiKey: "synthetic", positionId: "sid", userId: "" };
const SETTINGS: EzdSettings = { card: "urzad", ...CONFIG };
const ADE = "AE:PL-12345-67890-ABCDE-12";
const pem = (label: string, der: ArrayBuffer | Uint8Array): string => `-----BEGIN ${label}-----\n${Buffer.from(new Uint8Array(der)).toString("base64")}\n-----END ${label}-----\n`;
const ItemSchema = z.object({ details: z.string(), summary: z.string(), performer: z.object({ extension: z.string(), digest: z.string() }) });
const AttemptsSchema = z.object({ attempts: z.array(z.object({ approvalId: z.string(), approvedAt: z.number(), approver: z.string().optional(), outcome: z.string() })) });
const SnapshotSchema = z.object({ actions: z.array(z.object({ at: z.string(), key: z.string(), approvalId: z.string(), approvedBy: z.string().optional(), outcome: z.string() })) });

let root: string;
let stateDir: string;
let fake: FakeExtension;
let calls: Call[];
// An e-Doręczenia card's settings, as the daemon answers them.
interface EdCardConfig {
    readonly provider: "e-doreczenia";
    readonly environment: string;
    readonly ade: string;
    readonly systemName: string;
    readonly certificate: string;
    readonly privateKey: string;
    readonly uaUrl?: string;
    readonly tokenUrl?: string;
}

// The two cards as the daemon holds them now: a test edits one after the yes to move the act somewhere else.
interface Cards {
    readonly urzad: typeof CONFIG;
    readonly skrzynka: EdCardConfig;
}
let cards: Cards;
let ED_CONFIG: EdCardConfig;
let uploadAnswer: () => Response;
const realFetch = globalThis.fetch;

beforeAll(async () => {
    const system = await party({ subject: [["2.5.4.3", "Example office system"]], serial: 91 });
    ED_CONFIG = {
        provider: "e-doreczenia",
        environment: "https://int-ow.edoreczenia.gov.pl",
        ade: ADE,
        systemName: "EZD",
        certificate: pem("CERTIFICATE", system.der),
        privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", system.keys.privateKey)),
    };
});

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "e-urzad-perform-"));
    stateDir = await mkdtemp(join(tmpdir(), "e-urzad-state-"));
    await mkdir(join(root, STATE_GROUP_DIR.config), { recursive: true });
    cards = { urzad: CONFIG, skrzynka: ED_CONFIG };
    uploadAnswer = () => json({ lista: [{ idDokument: "d", idDokumentPrzestrzeni: "dp", idDokumentWersja: "dw", idPrzestrzenRobocza: "pr" }] }, 201);
    const office = recorder((call) =>
        call.url.pathname.endsWith("/token") ? json({ access_token: "t", expires_in: 300 }) : call.url.pathname.endsWith("/messages") ? json({ messageTaskId: "task-1" }, 202) : uploadAnswer(),
    );
    calls = office.calls;
    globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => office.fetcher(String(input), init), { preconnect: realFetch.preconnect });
    fake = await fakeExtensionApi({
        manifest: { publisher: manifest.publisher, name: manifest.name, permissions: manifest.permissions },
        workspaceRoot: root,
        stateDir,
        daemon: (request) => {
            const id = decodeURIComponent(new URL(request.url).pathname.split("/")[2] ?? "");
            const config = id === "urzad" ? cards.urzad : id === "skrzynka" ? cards.skrzynka : undefined;
            return config === undefined ? undefined : Response.json({ id, kind: "cli", config });
        },
    });
    await fake.activate({ activateServer });
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    await fake.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
});

const uploads = (): Call[] => calls.filter((call) => call.url.pathname.endsWith("/sprawy/sprawa-1/dokumenty"));

// Holds an attach as the agent's CLI would, and answers the action the daemon hands over once a person approved it.
const approvedAttach = async (approvedAt = 1_760_000_000_000): Promise<ApprovedAction> => {
    const draft = join(root, "projekt.pdf");
    await writeFile(draft, "%PDF-1.7 projekt");
    const { approvalId } = await new ActionGuard(root).propose(proposeAttach(SETTINGS, "sprawa-1", [{ path: draft }]));
    const item = ItemSchema.parse(JSON.parse(await readFile(join(approvalsDir(root), `${approvalId}.json`), "utf8")));
    return { id: approvalId, digest: item.performer.digest, summary: item.summary, details: item.details, approver: "urzednik@example.gov.pl", approvedAt, actionRules: {} };
};

// Holds an e-Doręczenia send from the card as it stands, as the CLI would.
const MESSAGE = { messageMetadata: { from: { eDeliveryAddress: ADE }, to: [{ eDeliveryAddress: "AE:PL-99999-99999-ZZZZZ-99" }], subject: "Odpowiedź na wniosek", shippingService: "electronic" }, textBody: "W załączeniu pismo." };
const approvedSend = async (approvedAt = 1_760_000_000_000): Promise<ApprovedAction> => {
    const { approvalId } = await new ActionGuard(root).propose(proposeSend(edFromConfig("skrzynka", { ...ED_CONFIG }), MESSAGE, []));
    const item = ItemSchema.parse(JSON.parse(await readFile(join(approvalsDir(root), `${approvalId}.json`), "utf8")));
    return { id: approvalId, digest: item.performer.digest, summary: item.summary, details: item.details, approver: "urzednik@example.gov.pl", approvedAt, actionRules: {} };
};

const attempts = async () => AttemptsSchema.parse(JSON.parse(await readFile(join(stateDir, ATTEMPTS_FILE), "utf8"))).attempts;

describe("an approved office act, carried out by the backend", () => {
    test("is sent once, with the approved bytes, and recorded with who approved it", async () => {
        const action = await approvedAttach();
        expect(await fake.perform(action)).toEqual({
            outcome: "done",
            result: JSON.stringify({ caseId: "sprawa-1", documents: [{ idDokument: "d", idDokumentPrzestrzeni: "dp", idDokumentWersja: "dw", idPrzestrzenRobocza: "pr" }] }),
        });
        expect(calls.map((call) => call.url.pathname)).toEqual(["/connect/token", "/ezdrp/integrator/v2/sprawy/sprawa-1/dokumenty"]);
        const form = uploads()[0]?.init?.body;
        const sent = form instanceof FormData ? form.getAll("files")[0] : undefined;
        expect(sent instanceof File ? await sent.text() : undefined).toBe("%PDF-1.7 projekt");
        const snapshot = SnapshotSchema.parse(JSON.parse(await readFile(join(recordsDir(root, "urzad"), "snapshot.json"), "utf8")));
        expect(snapshot.actions[0]).toEqual({ at: expect.any(String), key: "ezdrp.case.attach-draft", approvalId: action.id, approvedBy: "urzednik@example.gov.pl", outcome: action.summary });
        expect(await attempts()).toMatchObject([{ approvalId: action.id, approvedAt: action.approvedAt, approver: "urzednik@example.gov.pl", outcome: "done" }]);
    });

    test("the same yes handed over again is refused and nothing is sent twice; a new yes may run it again", async () => {
        const action = await approvedAttach();
        expect((await fake.perform(action)).outcome).toBe("done");
        expect(await fake.perform(action)).toEqual({ outcome: "refused", error: `approval ${action.id} was already attempted on this yes; it is never carried out twice, and nothing was sent again` });
        expect(uploads()).toHaveLength(1);
        expect((await fake.perform({ ...action, approvedAt: action.approvedAt + 60_000 })).outcome).toBe("done");
        expect(uploads()).toHaveLength(2);
    });

    test("two hand-overs of one yes at once: one is carried out, the other refused", async () => {
        const action = await approvedAttach();
        const outcomes = await Promise.all([fake.perform(action), fake.perform(action)]);
        expect(outcomes.map((outcome) => outcome.outcome).toSorted()).toEqual(["done", "refused"]);
        expect(uploads()).toHaveLength(1);
    });

    test("an operation changed after the yes is refused before anything reaches the office", async () => {
        const action = await approvedAttach();
        const path = join(mediaDir(root, action.id), OPERATION_FILE);
        const operation = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, "utf8")));
        await writeFile(path, JSON.stringify({ ...operation, args: { caseId: "sprawa-2" } }));
        expect(await fake.perform(action)).toEqual({ outcome: "refused", error: `approval ${action.id} no longer matches the operation that was approved` });
        expect(calls).toHaveLength(0);
    });

    test("a file copy changed after the yes is refused before anything reaches the office", async () => {
        const action = await approvedAttach();
        await writeFile(join(mediaDir(root, action.id), "0-projekt.pdf"), "%PDF-1.7 podmieniony");
        expect(await fake.perform(action)).toEqual({ outcome: "refused", error: "the approved file projekt.pdf changed after it was approved" });
        expect(calls).toHaveLength(0);
    });

    test("an item whose card text did not show the operation is refused, whatever its digest", async () => {
        const action = await approvedAttach();
        expect(await fake.perform({ ...action, details: "Dodaje jeden plik do sprawy." })).toEqual({
            outcome: "refused",
            error: `approval ${action.id} did not show this exact operation when it was approved`,
        });
        expect(calls).toHaveLength(0);
    });

    test("a rule set to deny after the yes still refuses", async () => {
        const action = await approvedAttach();
        expect(await fake.perform({ ...action, actionRules: { "ezdrp.*": "deny" } })).toEqual({ outcome: "refused", error: "ezdrp.case.attach-draft is refused by this sandbox's action rules" });
        expect(calls).toHaveLength(0);
    });

    test("an office that fails mid-act leaves the outcome uncertain, journalled, and never retried on the same yes", async () => {
        const action = await approvedAttach();
        uploadAnswer = () => json({ title: "Internal Server Error" }, 500);
        expect(await fake.perform(action)).toEqual({
            outcome: "uncertain",
            error: "integrator-api.example.test answered HTTP 500: Internal Server Error. The office may have received all or part of it",
        });
        expect(await attempts()).toMatchObject([{ approvalId: action.id, outcome: "uncertain" }]);
        uploadAnswer = () => json({ lista: [] }, 201);
        expect((await fake.perform(action)).outcome).toBe("refused");
        expect(uploads()).toHaveLength(1);
    });
});

// An edit that keeps the integrator's host can still move the act: another instance under a path, plain HTTP, another
// port, the key sent to another SSO, another position or user acting, another web host the key is bound to, another
// entity or key. Each is a change to what the person approved, read from the daemon's card rather than the shell.
describe("an EZD RP card edited after the yes", () => {
    const API = '"https://integrator-api.example.test/"';
    test.each([
        ["another office host", { apiUrl: "https://integrator-api.other.test" }, `apiUrl: ${API} → "https://integrator-api.other.test/"`],
        ["another instance under a path on the same host", { apiUrl: "https://integrator-api.example.test/inna-instancja" }, `apiUrl: ${API} → "https://integrator-api.example.test/inna-instancja"`],
        ["plain HTTP on the same host", { apiUrl: "http://integrator-api.example.test" }, `apiUrl: ${API} → "http://integrator-api.example.test/"`],
        ["another port on the same host", { apiUrl: "https://integrator-api.example.test:8443" }, `apiUrl: ${API} → "https://integrator-api.example.test:8443/"`],
        ["the key exchanged at another SSO path", { ssoUrl: "https://sso-idp.example.test/inne" }, 'ssoUrl: "https://sso-idp.example.test/" → "https://sso-idp.example.test/inne"'],
        ["another position", { positionId: "sid-2" }, 'positionId: "sid" → "sid-2"'],
        ["the position left to EZD", { positionId: "" }, 'positionId: "sid" → null'],
        ["another user acting", { userId: "inny-urzednik" }, 'userId: null → "inny-urzednik"'],
        ["another web host the key is bound to", { webHost: "ezdrp-web.other.test" }, 'webHost: "ezdrp-web.example.test" → "ezdrp-web.other.test"'],
        ["another entity", { subjectId: "pid-2" }, 'subjectId: "pid" → "pid-2"'],
        ["another key", { keyId: "aki-2" }, 'keyId: "aki" → "aki-2"'],
    ])("refuses %s before anything reaches the office", async (_what, edit, change) => {
        const action = await approvedAttach();
        cards = { ...cards, urzad: { ...CONFIG, ...edit } };
        expect(await fake.perform(action)).toEqual({ outcome: "refused", error: `the card "urzad" changed since this was approved (${change})` });
        expect(calls).toHaveLength(0);
    });

    test("another spelling of the same address, or a rotated key value, is the same scope and goes through", async () => {
        const action = await approvedAttach();
        cards = { ...cards, urzad: { ...CONFIG, apiUrl: "https://integrator-api.example.test/", apiKey: "rotated" } };
        expect((await fake.perform(action)).outcome).toBe("done");
        expect(uploads()).toHaveLength(1);
    });

    test("the scope the person approved is on the card, and no credential is", async () => {
        const action = await approvedAttach();
        expect(action.details).toContain('"positionId": "sid"');
        expect(action.details).toContain('"apiUrl": "https://integrator-api.example.test/"');
        expect(action.details).not.toContain("synthetic");
    });
});

describe("an e-Doręczenia send", () => {
    test("is sent once from the approved mailbox, with the message approved", async () => {
        const action = await approvedSend();
        expect(await fake.perform(action)).toMatchObject({ outcome: "done" });
        const sent = calls.filter((call) => call.url.pathname === `/api/v3/${ADE}/messages`);
        expect(sent).toHaveLength(1);
        expect(bodyOf(sent[0])["messageMetadata"]).toEqual(MESSAGE.messageMetadata);
        expect(action.details).not.toContain("PRIVATE KEY");
    });

    test.each([
        ["another mailbox", { ade: "AE:PL-11111-22222-CCCCC-33" }, `ade: "${ADE}" → "AE:PL-11111-22222-CCCCC-33"`],
        ["another registered system", { systemName: "INNY" }, 'systemName: "EZD" → "INNY"'],
        [
            "another UA path on the same host",
            { uaUrl: "https://uaapi-int-ow.poczta-polska.pl/api/v4" },
            'uaUrl: "https://uaapi-int-ow.poczta-polska.pl/api/v3" → "https://uaapi-int-ow.poczta-polska.pl/api/v4"',
        ],
        [
            "another token endpoint",
            { tokenUrl: "https://int-ow.edoreczenia.gov.pl/auth/realms/INNY/protocol/openid-connect/token" },
            'tokenUrl: "https://int-ow.edoreczenia.gov.pl/auth/realms/EDOR/protocol/openid-connect/token" → "https://int-ow.edoreczenia.gov.pl/auth/realms/INNY/protocol/openid-connect/token"',
        ],
    ])("refuses %s before anything reaches the office", async (_what, edit, change) => {
        const action = await approvedSend();
        cards = { ...cards, skrzynka: { ...ED_CONFIG, ...edit } };
        expect(await fake.perform(action)).toEqual({ outcome: "refused", error: `the card "skrzynka" changed since this was approved (${change})` });
        expect(calls).toHaveLength(0);
    });

    test("refuses INT switched to PROD, naming every address that moved with it", async () => {
        const action = await approvedSend();
        cards = { ...cards, skrzynka: { ...ED_CONFIG, environment: "https://ow.edoreczenia.gov.pl" } };
        const outcome = await fake.perform(action);
        expect(outcome.outcome).toBe("refused");
        expect(outcome.outcome === "refused" ? outcome.error.match(/(environment|uaUrl|tokenUrl|audience):/g) : []).toEqual(["environment:", "uaUrl:", "tokenUrl:", "audience:"]);
        expect(calls).toHaveLength(0);
    });
});
