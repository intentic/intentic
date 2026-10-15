import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { z } from "zod";
import { perform, proposeAttach, proposeSend } from "./actions.js";
import { ACTION_KEY_LIST, approvalsDir, ActionGuard, ruleFor } from "./core/guard.js";
import { bodyOf, json, recorder } from "./core/http.testing.js";
import { OfficeRecords } from "./core/records.js";
import { edSettings, type EdSettings } from "./ed/system-login.js";
import { EdClient } from "./ed/mailbox.js";
import type { EzdSettings } from "./ezd/key-exchange.js";
import { EzdClient } from "./ezd/integrator.js";
import { party } from "./signatures/fixtures.testing.js";

const ADE = "AE:PL-12345-67890-ABCDE-12";
const ezd: EzdSettings = { card: "urzad", apiUrl: "https://integrator-api.example.test", ssoUrl: "https://sso-idp.example.test", webHost: "ezdrp-web.example.test", subjectId: "pid", keyId: "aki", apiKey: "synthetic", positionId: "sid" };
const ItemSchema = z.object({ kind: z.literal("action"), summary: z.string(), details: z.string(), instructions: z.string(), status: z.string() });
const pem = (label: string, der: ArrayBuffer | Uint8Array): string => `-----BEGIN ${label}-----\n${Buffer.from(new Uint8Array(der)).toString("base64")}\n-----END ${label}-----\n`;

let root: string;
let ed: EdSettings;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "e-urzad-guard-"));
    await mkdir(join(root, STATE_GROUP_DIR.config), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

beforeAll(async () => {
    const system = await party({ subject: [["2.5.4.3", "Example office system"]], serial: 90 });
    ed = edSettings({ card: "skrzynka", environment: "INT", ade: ADE, systemName: "EZD", certificate: pem("CERTIFICATE", system.der), privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", system.keys.privateKey)) });
});

const setRules = (rules: Record<string, string>): Promise<void> => writeFile(join(root, STATE_GROUP_DIR.config, "settings.json"), JSON.stringify({ actionRules: rules }));
const itemOf = async (id: string) => ItemSchema.parse(JSON.parse(await readFile(join(approvalsDir(root), `${id}.json`), "utf8")));
const markRunning = async (id: string): Promise<void> => {
    const path = join(approvalsDir(root), `${id}.json`);
    await writeFile(path, JSON.stringify({ ...(await itemOf(id)), status: "running" }));
};

describe("the action rules", () => {
    test("every office key holds unless the owner set allow or deny, exact key before wildcard", () => {
        for (const key of ACTION_KEY_LIST) {
            expect(ruleFor(undefined, key)).toBe("hold");
            expect(ruleFor({ [key]: "something else" }, key)).toBe("hold");
        }
        expect(ruleFor({ "ezdrp.*": "allow" }, "ezdrp.case.attach-draft")).toBe("allow");
        expect(ruleFor({ "ezdrp.*": "allow", "ezdrp.case.attach-draft": "deny" }, "ezdrp.case.attach-draft")).toBe("deny");
    });

    test("held by default: the approval item and file copies are written, nothing reaches the office", async () => {
        const file = join(root, "projekt.pdf");
        await writeFile(file, "%PDF-1.7 projekt");
        let acted = 0;
        const outcome = await new ActionGuard(root).run(proposeAttach(ezd, "sprawa-1", [{ path: file }]), () => {
            acted += 1;
            return Promise.resolve({});
        });
        expect(acted).toBe(0);
        expect(outcome.done).toBe(false);
        const id = outcome.done ? "" : outcome.approvalId;
        const item = await itemOf(id);
        expect(item.status).toBe("proposed");
        expect(item.summary).toContain("add 1 file(s) to case sprawa-1");
        expect(item.details).toContain("ezdrp.case.attach-draft");
        expect(item.instructions).toContain(`e-urzad approved ${id}`);
        expect((await readdir(join(approvalsDir(root), "media", id))).toSorted()).toEqual(["0-projekt.pdf", "operation.json"]);
    });

    test("deny refuses and allow acts at once", async () => {
        await setRules({ "ezdrp.*": "deny" });
        await expect(new ActionGuard(root).run(proposeAttach(ezd, "s", [{ path: __filename }]), () => Promise.resolve(1))).rejects.toThrow("refused");
        await setRules({ "ezdrp.case.attach-draft": "allow" });
        expect(await new ActionGuard(root).run(proposeAttach(ezd, "s", [{ path: __filename }]), () => Promise.resolve(1))).toEqual({ done: true, result: 1 });
    });

    test("an approval acts only while running, and only on the exact bytes approved", async () => {
        const file = join(root, "projekt.pdf");
        await writeFile(file, "%PDF-1.7 projekt");
        const guard = new ActionGuard(root);
        const outcome = await guard.run(proposeAttach(ezd, "sprawa-1", [{ path: file }]), () => Promise.resolve({}));
        const id = outcome.done ? "" : outcome.approvalId;
        await expect(guard.approved(id)).rejects.toThrow("not running");
        await markRunning(id);
        await writeFile(file, "%PDF-1.7 zmieniony po zatwierdzeniu");
        const operation = await guard.approved(id);
        expect(await readFile(operation.files[0]?.path ?? "", "utf8")).toBe("%PDF-1.7 projekt");
        await writeFile(operation.files[0]?.path ?? "", "%PDF-1.7 podmieniony");
        await expect(guard.approved(id)).rejects.toThrow("changed after it was approved");
        await expect(guard.approved("../settings")).rejects.toThrow("not an e-urzad approval id");
    });
});

describe("approved office acts", () => {
    test("an approved attach uploads the approved copies as multipart files to the case", async () => {
        const file = join(root, "projekt.pdf");
        await writeFile(file, "%PDF-1.7 projekt");
        const guard = new ActionGuard(root);
        const outcome = await guard.run(proposeAttach(ezd, "sprawa-1", [{ path: file, name: "Projekt decyzji.pdf" }]), () => Promise.resolve({}));
        const id = outcome.done ? "" : outcome.approvalId;
        await markRunning(id);
        const { calls, fetcher } = recorder((call) =>
            call.url.pathname === "/connect/token" ? json({ access_token: "t", expires_in: 3600 }) : json({ lista: [{ idDokument: "d", idDokumentPrzestrzeni: "dp", idDokumentWersja: "dw", idPrzestrzenRobocza: "pr" }] }, 201),
        );
        const result = await perform(await guard.approved(id), { ezd: new EzdClient(ezd, fetcher) }, new OfficeRecords(root, "urzad", "ezd-rp"));
        expect(result).toEqual({ caseId: "sprawa-1", documents: [{ idDokument: "d", idDokumentPrzestrzeni: "dp", idDokumentWersja: "dw", idPrzestrzenRobocza: "pr" }] });
        const upload = calls.find((call) => call.url.pathname.endsWith("/sprawy/sprawa-1/dokumenty"));
        const form = upload?.init?.body;
        expect(form).toBeInstanceOf(FormData);
        const sent = form instanceof FormData ? form.getAll("files") : [];
        expect(sent).toHaveLength(1);
        const blob = sent[0];
        expect(blob instanceof File ? [blob.name, await blob.text()] : []).toEqual(["Projekt decyzji.pdf", "%PDF-1.7 projekt"]);
    });

    test("a send is checked before it is held, and the approved run posts the UA Message with inline attachments", async () => {
        expect(() => proposeSend(ed, { messageMetadata: { from: { eDeliveryAddress: "AE:PL-OTHER" }, to: [{ eDeliveryAddress: "AE:PL-1" }], subject: "x", shippingService: "electronic" } }, [])).toThrow("must be this card's mailbox");
        const file = join(root, "pismo.pdf");
        await writeFile(file, "%PDF-1.7 pismo");
        const message = { messageMetadata: { from: { eDeliveryAddress: ADE }, to: [{ eDeliveryAddress: "AE:PL-99999-99999-ZZZZZ-99" }], subject: "Odpowiedź na wniosek", shippingService: "electronic" }, textBody: "W załączeniu pismo." };
        const guard = new ActionGuard(root);
        const outcome = await guard.run(proposeSend(ed, message, [{ path: file }]), () => Promise.resolve({}));
        const id = outcome.done ? "" : outcome.approvalId;
        expect((await itemOf(id)).summary).toBe('e-Doręczenia INT: send "Odpowiedź na wniosek" to AE:PL-99999-99999-ZZZZZ-99');
        await markRunning(id);
        const { calls, fetcher } = recorder((call) => (call.url.pathname.endsWith("/token") ? json({ access_token: "t", expires_in: 300 }) : json({ messageTaskId: "task-1" }, 202)));
        const result = await perform(await guard.approved(id), { ed: new EdClient(ed, fetcher) }, new OfficeRecords(root, "skrzynka", "e-doreczenia"));
        expect(result["messageTaskId"]).toBe("task-1");
        const sent = bodyOf(calls.find((call) => call.url.pathname === `/api/v3/${ADE}/messages`));
        expect(sent["messageMetadata"]).toEqual(message.messageMetadata);
        const attachments = z.array(z.object({ order: z.number(), file: z.object({ fileMetadata: z.object({ filename: z.string(), contentType: z.string(), size: z.number() }), file: z.string() }) })).parse(sent["attachments"]);
        expect(attachments[0]?.file.fileMetadata).toMatchObject({ filename: "pismo.pdf", contentType: "application/pdf", size: 14 });
        expect(Buffer.from(attachments[0]?.file.file ?? "", "base64").toString()).toBe("%PDF-1.7 pismo");
    });
});
