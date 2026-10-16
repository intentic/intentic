import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { z } from "zod";
import { perform, proposeAttach, proposeOpen, proposeSend, StillPending } from "./actions.js";
import { type ApprovalClaim, loadApproved } from "./core/approved-operation.js";
import { ACTION_KEY_LIST, ActionGuard, approvalsDir, digestOf, mediaDir, OPERATION_FILE, OperationSchema, operationBlock, PERFORMER, ruleFor } from "./core/guard.js";
import { bodyOf, json, recorder } from "./core/http.testing.js";
import { OfficeRecords } from "./core/records.js";
import { edSettings, type EdSettings } from "./ed/system-login.js";
import { EdClient } from "./ed/mailbox.js";
import type { EzdSettings } from "./ezd/key-exchange.js";
import { EzdClient } from "./ezd/integrator.js";
import { party } from "./signatures/fixtures.testing.js";

// The guard holds every office act, and an approval is loaded only exactly as it was approved: the operation and the
// file copies read once, held to the digest the person's yes pinned and to the card text they read. What is performed
// is those loaded bytes, whatever the workspace holds afterwards.

const ADE = "AE:PL-12345-67890-ABCDE-12";
const ezd: EzdSettings = { card: "urzad", apiUrl: "https://integrator-api.example.test", ssoUrl: "https://sso-idp.example.test", webHost: "ezdrp-web.example.test", subjectId: "pid", keyId: "aki", apiKey: "synthetic", positionId: "sid" };
const ItemSchema = z.object({
    kind: z.literal("action"),
    summary: z.string(),
    details: z.string(),
    instructions: z.string(),
    status: z.string(),
    performer: z.object({ extension: z.string(), digest: z.string() }),
});
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
// What the daemon hands the backend for an item a person approved as it stands: its id, the pinned digest, its details.
const claimOf = async (id: string): Promise<ApprovalClaim> => {
    const item = await itemOf(id);
    return { id, digest: item.performer.digest, details: item.details };
};
const operationPath = (id: string): string => join(mediaDir(root, id), OPERATION_FILE);

const holdAttach = async (content = "%PDF-1.7 projekt", name?: string): Promise<{ readonly id: string; readonly file: string }> => {
    const file = join(root, "projekt.pdf");
    await writeFile(file, content);
    const held = await new ActionGuard(root).propose(proposeAttach(ezd, "sprawa-1", [{ path: file, name }]));
    return { id: held.approvalId, file };
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

    test("held by default: the item names this extension as performer, shows the exact operation, and copies the files", async () => {
        const { id } = await holdAttach();
        const item = await itemOf(id);
        expect(item.status).toBe("proposed");
        expect(item.summary).toBe("EZD RP: add 1 file(s) to case sprawa-1");
        const operation = OperationSchema.parse(JSON.parse(await readFile(operationPath(id), "utf8")));
        const digest = digestOf(operation);
        expect(item.performer).toEqual({ extension: "intentic.e-urzad", digest });
        expect(PERFORMER).toBe("intentic.e-urzad");
        expect(item.details).toContain(operationBlock(operation, digest));
        expect(operation.files).toEqual([{ name: "projekt.pdf", file: "0-projekt.pdf", sha256: createHash("sha256").update("%PDF-1.7 projekt").digest("hex"), bytes: 16 }]);
        // The whole destination and acting identity, without the key: the base address, the SSO, the bound web host, the
        // entity, the key id, the position and the user.
        expect(operation.scope).toEqual({
            service: "ezd-rp",
            apiUrl: "https://integrator-api.example.test/",
            ssoUrl: "https://sso-idp.example.test/",
            webHost: "ezdrp-web.example.test",
            subjectId: "pid",
            keyId: "aki",
            positionId: "sid",
            userId: null,
        });
        expect(item.details).not.toContain(ezd.apiKey);
        expect(item.instructions).not.toContain("e-urzad approved");
        expect((await readdir(mediaDir(root, id))).toSorted()).toEqual(["0-projekt.pdf", OPERATION_FILE]);
    });

    test("a held delivery pins the mailbox, the system and every address it signs in and sends through, and no key", async () => {
        const held = await new ActionGuard(root).propose(proposeOpen(ed, "msg-1", undefined));
        const operation = OperationSchema.parse(JSON.parse(await readFile(operationPath(held.approvalId), "utf8")));
        expect(operation.scope).toEqual({
            service: "e-doreczenia",
            environment: "INT",
            ade: ADE,
            systemName: "EZD",
            uaUrl: "https://uaapi-int-ow.poczta-polska.pl/api/v3",
            tokenUrl: "https://int-ow.edoreczenia.gov.pl/auth/realms/EDOR/protocol/openid-connect/token",
            audience: "https://int-ow.edoreczenia.gov.pl/auth/realms/EDOR",
        });
        const details = (await itemOf(held.approvalId)).details;
        expect(details).not.toContain("PRIVATE KEY");
        expect(details).not.toContain("CERTIFICATE");
    });

    test("deny refuses, and allow no longer acts at once: the act is held for a person all the same", async () => {
        await setRules({ "ezdrp.*": "deny" });
        await expect(new ActionGuard(root).propose(proposeAttach(ezd, "s", [{ path: __filename }]))).rejects.toThrow("refused by this sandbox's action rules");
        expect(await readdir(approvalsDir(root)).catch(() => [])).toEqual([]);
        await setRules({ "ezdrp.case.attach-draft": "allow" });
        const held = await new ActionGuard(root).propose(proposeAttach(ezd, "s", [{ path: __filename }]));
        expect(held.message).toContain("carried out only on a person's approval");
        expect((await itemOf(held.approvalId)).status).toBe("proposed");
    });
});

describe("loading an approval", () => {
    test("loads exactly the approved copy, even after the workspace file changed", async () => {
        const { id, file } = await holdAttach();
        await writeFile(file, "%PDF-1.7 zmieniony po zatwierdzeniu");
        const loaded = await loadApproved(root, await claimOf(id));
        expect(loaded.operation.key).toBe("ezdrp.case.attach-draft");
        expect(loaded.files.map((each) => [each.name, Buffer.from(each.bytes).toString()])).toEqual([["projekt.pdf", "%PDF-1.7 projekt"]]);
    });

    test("a copy changed after approval is refused", async () => {
        const { id } = await holdAttach();
        await writeFile(join(mediaDir(root, id), "0-projekt.pdf"), "%PDF-1.7 podmieniony");
        await expect(loadApproved(root, await claimOf(id))).rejects.toThrow("the approved file projekt.pdf changed after it was approved");
    });

    test("an operation edited after approval no longer matches the digest the yes pinned", async () => {
        const { id } = await holdAttach();
        const claim = await claimOf(id);
        const operation = OperationSchema.parse(JSON.parse(await readFile(operationPath(id), "utf8")));
        await writeFile(operationPath(id), JSON.stringify({ ...operation, args: { caseId: "inna-sprawa" } }));
        await expect(loadApproved(root, claim)).rejects.toThrow(`approval ${id} no longer matches the operation that was approved`);
    });

    test("an edited operation with its item re-pointed at the new digest is refused unless the card showed it", async () => {
        const { id } = await holdAttach();
        const claim = await claimOf(id);
        const operation = OperationSchema.parse(JSON.parse(await readFile(operationPath(id), "utf8")));
        const forged = { ...operation, args: { caseId: "inna-sprawa" } };
        await writeFile(operationPath(id), JSON.stringify(forged));
        await expect(loadApproved(root, { ...claim, digest: digestOf(forged) })).rejects.toThrow(`approval ${id} did not show this exact operation when it was approved`);
    });

    test("a copy swapped for a link to another file is refused rather than read", async () => {
        const { id } = await holdAttach();
        const secret = join(root, "secret.txt");
        await writeFile(secret, "%PDF-1.7 projekt");
        await unlink(join(mediaDir(root, id), "0-projekt.pdf"));
        await symlink(secret, join(mediaDir(root, id), "0-projekt.pdf"));
        await expect(loadApproved(root, await claimOf(id))).rejects.toThrow("the approved copy 0-projekt.pdf cannot be read (ELOOP)");
    });

    test("an id that is not an e-urzad approval, or has no operation, is refused", async () => {
        await expect(loadApproved(root, { id: "../settings", digest: "0".repeat(64), details: "" })).rejects.toThrow('"../settings" is not an e-urzad approval id');
        const missing = "e-urzad-00000000-0000-0000-0000-000000000000";
        await expect(loadApproved(root, { id: missing, digest: "0".repeat(64), details: "" })).rejects.toThrow(`approval ${missing} has no operation on record (ENOENT)`);
    });
});

describe("approved office acts", () => {
    test("an approved attach uploads the bytes that were loaded, not what the copy holds by the time it is sent", async () => {
        const { id } = await holdAttach("%PDF-1.7 projekt", "Projekt decyzji.pdf");
        const loaded = await loadApproved(root, await claimOf(id));
        await writeFile(join(mediaDir(root, id), "0-Projekt decyzji.pdf"), "%PDF-1.7 podmieniony po sprawdzeniu");
        const { calls, fetcher } = recorder((call) =>
            call.url.pathname === "/connect/token" ? json({ access_token: "t", expires_in: 3600 }) : json({ lista: [{ idDokument: "d", idDokumentPrzestrzeni: "dp", idDokumentWersja: "dw", idPrzestrzenRobocza: "pr" }] }, 201),
        );
        const result = await perform(loaded, { ezd: new EzdClient(ezd, fetcher) }, new OfficeRecords(root, "urzad", "ezd-rp"));
        expect(result).toEqual({ caseId: "sprawa-1", documents: [{ idDokument: "d", idDokumentPrzestrzeni: "dp", idDokumentWersja: "dw", idPrzestrzenRobocza: "pr" }] });
        const form = calls.find((call) => call.url.pathname.endsWith("/sprawy/sprawa-1/dokumenty"))?.init?.body;
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
        const held = await new ActionGuard(root).propose(proposeSend(ed, message, [{ path: file }]));
        expect((await itemOf(held.approvalId)).summary).toBe('e-Doręczenia INT: send "Odpowiedź na wniosek" to AE:PL-99999-99999-ZZZZZ-99');
        const { calls, fetcher } = recorder((call) => (call.url.pathname.endsWith("/token") ? json({ access_token: "t", expires_in: 300 }) : json({ messageTaskId: "task-1" }, 202)));
        const result = await perform(await loadApproved(root, await claimOf(held.approvalId)), { ed: new EdClient(ed, fetcher) }, new OfficeRecords(root, "skrzynka", "e-doreczenia"));
        expect(result["messageTaskId"]).toBe("task-1");
        const sent = bodyOf(calls.find((call) => call.url.pathname === `/api/v3/${ADE}/messages`));
        expect(sent["messageMetadata"]).toEqual(message.messageMetadata);
        const attachments = z.array(z.object({ order: z.number(), file: z.object({ fileMetadata: z.object({ filename: z.string(), contentType: z.string(), size: z.number() }), file: z.string() }) })).parse(sent["attachments"]);
        expect(attachments[0]?.file.fileMetadata).toMatchObject({ filename: "pismo.pdf", contentType: "application/pdf", size: 14 });
        expect(Buffer.from(attachments[0]?.file.file ?? "", "base64").toString()).toBe("%PDF-1.7 pismo");
    });

    test("a delivery the operator is still preparing is asked again within the act, then reported as pending", async () => {
        const held = await new ActionGuard(root).propose(proposeOpen(ed, "msg-1", undefined));
        const loaded = await loadApproved(root, await claimOf(held.approvalId));
        const { calls, fetcher } = recorder((call) => (call.url.pathname.endsWith("/token") ? json({ access_token: "t", expires_in: 300 }) : json({ status: "PROCESSING" }, 202)));
        const waits: number[] = [];
        const opening = perform(loaded, { ed: new EdClient(ed, fetcher) }, new OfficeRecords(root, "skrzynka", "e-doreczenia"), {
            pendingRetries: 2,
            wait: async (ms) => {
                waits.push(ms);
            },
        });
        await expect(opening).rejects.toBeInstanceOf(StillPending);
        await expect(opening).rejects.toThrow("e-Doręczenia is still preparing this delivery (status PROCESSING)");
        expect(calls.filter((call) => call.url.pathname === `/api/v3/${ADE}/messages/msg-1`)).toHaveLength(3);
        expect(waits).toEqual([5_000, 5_000]);
    });
});
