import type { ApprovedAction } from "@intentic/extension-api";
import { fakeExtensionApi } from "@intentic/extension-api/testing";
import { type ApprovalSchema, ApprovalSummarySchema } from "@intentic/sandbox-contract/schemas/approvals";
import { z } from "zod";
import { CheckpointSchema } from "../log/checkpoint.js";
import { ServedEntrySchema } from "../log/entry.js";
import { fromBase64, leafHash } from "../log/merkle.js";
import { verifyLog } from "../log/verify.js";
import { manifest } from "../manifest.js";
import * as server from "./server.js";

/* THE PUBLISHING ROUND TRIP, on the real API against a fake daemon whose `api.identity` signs with a real key set: a
   draft goes to the approvals queue, a person's yes reaches `perform`, the entry and a checkpoint are signed, and a far
   reader verifies the whole log from the public doors alone. Then a withdrawal, an altered approval and a forged
   co-signature. */

// What the backend filed in the approvals queue (POST /approvals on the fake daemon), by item id.
type Filed = Map<string, z.infer<typeof ApprovalSchema>>;
const approvalOf = async (filed: Filed, id: string) => {
    const item = filed.get(id);
    if (item === undefined) {
        throw new Error(`nothing was filed as ${id}`);
    }
    return item;
};

const yes = (id: string, digest: string, extra: Partial<ApprovedAction> = {}): ApprovedAction => ({ id, digest, summary: ``, details: ``, approvedAt: Date.now(), actionRules: {}, ...extra });

const EntriesSchema = z.object({ size: z.number(), entries: z.array(ServedEntrySchema) });
const ApprovalAnswerSchema = z.object({ approval: z.string() });

const setup = async () => {
    const filed: Filed = new Map();
    const fake = await fakeExtensionApi({
        manifest,
        daemon: async (request) => {
            if (request.method !== `POST` || new URL(request.url).pathname !== `/approvals`) {
                return undefined;
            }
            const item = ApprovalSummarySchema.parse(await request.json());
            filed.set(item.id, item);
            return Response.json({ ok: true });
        },
    });
    await fake.activate(server);
    const publish = async (text: string): Promise<string> => {
        const answer = await fake.route(`/publish`, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify({ text, keywords: [`ai`] }) });
        expect(answer.status).toBe(200);
        return ApprovalAnswerSchema.parse(await answer.json()).approval;
    };
    const readLog = async () => {
        const checkpoint = CheckpointSchema.parse(await (await fake.publicRoute(`log/checkpoint`)).json());
        const { entries } = EntriesSchema.parse(await (await fake.publicRoute(`log/entries?start=0&end=100`)).json());
        return { checkpoint, entries };
    };
    return { fake, publish, readLog, workspaceRoot: filed };
};

describe(`publishing to the Network log`, () => {
    it(`publishes only on a yes, and a far reader verifies the log from the public doors`, async () => {
        const { fake, publish, readLog, workspaceRoot } = await setup();
        const id = await publish(`Hello, Network.`);
        const approval = await approvalOf(workspaceRoot, id);
        if (approval.kind !== `action` || approval.performer === undefined) {
            throw new Error(`the draft was not filed as a performer action`);
        }
        expect(approval).toMatchObject({ status: `proposed`, cosign: `offered`, performer: { extension: `intentic.network` } });
        expect((await fake.publicRoute(`log/checkpoint`)).status).toBe(404);

        expect(await fake.perform(yes(id, approval.performer.digest))).toEqual({ outcome: `done`, result: `entry 0` });
        // Carrying the same yes out again changes nothing.
        expect(await fake.perform(yes(id, approval.performer.digest))).toEqual({ outcome: `done`, result: `entry 0` });

        const { checkpoint, entries } = await readLog();
        const verified = await verifyLog(fake.identity.document(), checkpoint, entries);
        expect(verified.ok).toBe(true);
        expect(entries[0]).toMatchObject({ seq: 0, signed: { entry: { record: { text: `Hello, Network.`, keywords: [`ai`] } } } });
        expect(checkpoint.body.startsWith(`sandbox-fake.sbx.test/intentic.network\n1\n`)).toBe(true);
    });

    it(`withdraws an entry: its text leaves, its leaf stays, and the log still verifies`, async () => {
        const { fake, publish, readLog, workspaceRoot } = await setup();
        for (const text of [`First`, `Second`]) {
            const id = await publish(text);
            const approval = await approvalOf(workspaceRoot, id);
            await fake.perform(yes(id, approval.kind === `action` ? (approval.performer?.digest ?? ``) : ``));
        }
        const withdraw = ApprovalAnswerSchema.parse(await (await fake.route(`/withdraw/0`, { method: `POST` })).json()).approval;
        const approval = await approvalOf(workspaceRoot, withdraw);
        expect(await fake.perform(yes(withdraw, approval.kind === `action` ? (approval.performer?.digest ?? ``) : ``))).toEqual({ outcome: `done`, result: `entry 2` });

        const { checkpoint, entries } = await readLog();
        expect(entries.map((entry) => (`erased` in entry ? `erased` : entry.signed.entry.tombstoneOf === undefined ? `record` : `tombstone`))).toEqual([`erased`, `record`, `tombstone`]);
        expect(JSON.stringify(entries)).not.toContain(`First`);
        expect((await verifyLog(fake.identity.document(), checkpoint, entries)).ok).toBe(true);
    });

    it(`serves proofs a reader checks against the signed root`, async () => {
        const { fake, publish, readLog, workspaceRoot } = await setup();
        for (const text of [`a`, `b`, `c`]) {
            const id = await publish(text);
            const approval = await approvalOf(workspaceRoot, id);
            await fake.perform(yes(id, approval.kind === `action` ? (approval.performer?.digest ?? ``) : ``));
        }
        const { entries } = await readLog();
        const proof = z.object({ proof: z.array(z.string()) }).parse(await (await fake.publicRoute(`log/proof/consistency?from=1&to=3`)).json());
        expect(proof.proof.map((hash) => fromBase64(hash)?.length)).toEqual([32, 32]);
        expect(entries).toHaveLength(3);
        expect(leafHash(new Uint8Array()).length).toBe(32);
    });

    it(`refuses an approval for other words, and a co-signature that does not verify`, async () => {
        const { fake, publish, workspaceRoot } = await setup();
        const id = await publish(`Exact words`);
        const approval = await approvalOf(workspaceRoot, id);
        const digest = approval.kind === `action` ? (approval.performer?.digest ?? ``) : ``;
        expect(await fake.perform(yes(id, `0`.repeat(64)))).toMatchObject({ outcome: `refused` });
        const forged = {
            v: 1 as const,
            challenge: { v: 1 as const, sandbox: `fake`, item: id, digest },
            credentialId: `AAAA`,
            publicKey: { alg: -7 as const, jwk: { kty: `EC`, crv: `P-256`, x: `AAAA`, y: `AAAA` } },
            rpId: `example.com`,
            authenticatorData: `AAAA`,
            clientDataJSON: `AAAA`,
            signature: `AAAA`,
        };
        expect(await fake.perform(yes(id, digest, { cosign: forged }))).toMatchObject({ outcome: `refused` });
        expect((await fake.publicRoute(`log/checkpoint`)).status).toBe(404);
    });

    it(`requires a passkey when the owner says so`, async () => {
        const { fake, publish, workspaceRoot } = await setup();
        fake.setSettings({ requirePasskey: true });
        const id = await publish(`Needs a passkey`);
        const approval = await approvalOf(workspaceRoot, id);
        expect(approval).toMatchObject({ cosign: `required` });
        expect(await fake.perform(yes(id, approval.kind === `action` ? (approval.performer?.digest ?? ``) : ``))).toMatchObject({ outcome: `refused`, error: `this needs approving with a passkey` });
    });

    it(`signs a catalog of what the log holds`, async () => {
        const { fake, publish, workspaceRoot } = await setup();
        fake.setSettings({ catalogKeywords: `ai, energy`, catalogLanguages: `pl` });
        const id = await publish(`Catalogued`);
        const approval = await approvalOf(workspaceRoot, id);
        await fake.perform(yes(id, approval.kind === `action` ? (approval.performer?.digest ?? ``) : ``));
        const catalog = z.object({ catalog: z.object({ size: z.number(), keywords: z.array(z.string()), inLanguage: z.array(z.string()), dataset: z.array(z.object({ about: z.string(), size: z.number() })) }) }).parse(await (await fake.publicRoute(`catalog`)).json());
        expect(catalog.catalog).toMatchObject({ size: 1, keywords: [`ai`, `energy`], inLanguage: [`pl`], dataset: [{ about: `SocialMediaPosting`, size: 1 }] });
    });
});
