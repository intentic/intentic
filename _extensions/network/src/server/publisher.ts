import { randomBytes } from "node:crypto";
import type { ApprovedAction, ApprovedActionOutcome, IdentityReach } from "@intentic/extension-api";
import { verifyPasskeyCosign } from "@intentic/sandbox-contract/s2s";
import type { ActionApprovalSummarySchema } from "@intentic/sandbox-contract/schemas/approvals";
import { z } from "zod";
import { checkpointBody, originOf } from "../log/checkpoint.js";
import { CHECKPOINT_PURPOSE, ENTRY_PURPOSE, type Entry, entryLeaf, EXTENSION_ID, publishDigest, type SignedEntry, withdrawDigest } from "../log/entry.js";
import { rootOf } from "../log/merkle.js";
import type { Publishing } from "../wire.js";
import type { CosignMode, Draft, LogStore } from "./log-store.js";
import { type NetworkRecord, RecordSchema } from "./records.js";

/* PUBLISHING AS THIS SANDBOX, ONLY ON A PERSON'S YES: a draft (from the view's composer or the agent's
   `network_publish`) becomes an item in the approvals queue that names this extension as its performer, with the
   digest of exactly what will be published and the passkey co-signature offered (or required, by the owner's setting).
   Once a person approves it, the daemon hands the item here; this recomputes the digest, checks the co-signature, signs
   the entry and a new checkpoint as the sandbox, and appends. Nothing reaches the log any other way. */

export const DraftInputSchema = z.object({
    type: z.enum([`SocialMediaPosting`, `Article`, `BlogPosting`]).default(`SocialMediaPosting`),
    headline: z.string().trim().max(300).optional(),
    text: z.string().trim().min(1).max(20_000),
    url: z.url().max(4096).optional(),
    inLanguage: z.string().max(35).optional(),
    keywords: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
});
export type DraftInput = z.input<typeof DraftInputSchema>;

// An action item as the approvals queue takes it.
export type ApprovalItem = z.input<typeof ActionApprovalSummarySchema>;

export interface PublisherDeps {
    readonly logs: LogStore;
    readonly identity: IdentityReach;
    // Files an item in the approvals queue (POST /approvals, as "proposed"): only a person's yes there moves it on.
    readonly fileApproval: (item: ApprovalItem) => Promise<void>;
    readonly cosignMode: () => Promise<CosignMode>;
    readonly authorName: () => Promise<string>;
    readonly now: () => number;
}

// A value as JSON carries it: what a signature and a digest are computed over, with no absent field spelled `undefined`.
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const refused = (error: string): ApprovedActionOutcome => ({ outcome: `refused`, error });

// The schema.org record a draft publishes: authored by this sandbox's key, under the name the owner set.
const recordOf = async (deps: PublisherDeps, input: DraftInput): Promise<NetworkRecord> => {
    const parsed = DraftInputSchema.parse(input);
    const document = await deps.identity.document();
    return asJson(
        RecordSchema.parse({
            "@context": `https://schema.org`,
            "@type": parsed.type,
            headline: parsed.headline ?? parsed.text.slice(0, 160),
            ...(parsed.type === `SocialMediaPosting` ? { text: parsed.text } : { articleBody: parsed.text }),
            url: parsed.url,
            datePublished: new Date(deps.now()).toISOString(),
            author: { "@type": `Person`, name: await deps.authorName(), identifier: document.fingerprint },
            sdPublisher: { "@type": `SoftwareApplication`, name: EXTENSION_ID },
            isBasedOn: [originOf(document.host)],
            inLanguage: parsed.inLanguage,
            keywords: parsed.keywords,
        }),
    );
};


// Why an approved item may not be carried out, or undefined when it may: what was approved must be what the draft
// publishes, and a passkey co-signature, required or not, must verify over that digest for this sandbox and item.
const approvalProblem = async (draft: Draft, action: ApprovedAction, sandbox: string): Promise<string | undefined> => {
    const digest = draft.kind === `publish` && draft.record !== undefined ? publishDigest(draft.record) : withdrawDigest(draft.target ?? -1);
    if (digest !== action.digest || digest !== draft.digest) {
        return `what was approved is not what this draft would publish`;
    }
    if (action.cosign === undefined) {
        return draft.cosign === `required` ? `this needs approving with a passkey` : undefined;
    }
    const check = await verifyPasskeyCosign(action.cosign, { sandbox, digest, item: action.id });
    return check.ok ? undefined : `the passkey co-signature does not verify: ${check.reason}`;
};

export const createPublisher = (deps: PublisherDeps) => {
    const { logs, identity } = deps;
    // One append at a time: a seq is the log's size when it is signed.
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(run: () => Promise<T>): Promise<T> => {
        const next = chain.then(run, run);
        // allow(silent-catch): the caller of `next` hears its failure; the chain only orders the appends after it
        chain = next.catch(() => undefined);
        return next;
    };

    const signCheckpoint = async (): Promise<void> => {
        const size = logs.size();
        const document = await identity.document();
        const body = checkpointBody({ origin: originOf(document.host), size, root: rootOf(logs.leaves(size)), publishedAt: new Date(deps.now()).toISOString() });
        const signed = await identity.sign(CHECKPOINT_PURPOSE, { body });
        logs.saveCheckpoint(size, { body, sig: signed.sig, fingerprint: signed.fingerprint }, deps.now());
    };

    const append = (fields: Pick<Entry, `record` | `tombstoneOf` | `cosign`>): Promise<number> =>
        serial(async () => {
            const seq = logs.size();
            const entry: Entry = asJson({ v: 1, seq, publishedAt: new Date(deps.now()).toISOString(), ...fields });
            const signed = await identity.sign(ENTRY_PURPOSE, entry);
            const stored: SignedEntry = { entry, sig: signed.sig, fingerprint: signed.fingerprint };
            logs.append(stored, entryLeaf(stored));
            await signCheckpoint();
            return seq;
        });

    const fileDraft = async (draft: Draft, summary: string, details: string): Promise<Draft> => {
        logs.saveDraft(draft);
        await deps.fileApproval({
            id: draft.id,
            kind: `action`,
            summary,
            details,
            instructions: `Nothing for an agent to do: the Network extension carries this out itself once it is approved.`,
            performer: { extension: EXTENSION_ID, digest: draft.digest },
            cosign: draft.cosign,
            status: `proposed`,
            createdAt: draft.createdAt,
        });
        return draft;
    };

    return {
        // What the Published tab shows: the log's size, its newest entries, what waits for a yes, and where it is read.
        overview: async (): Promise<Publishing> => {
            const catalogUrl = await identity.document().then(
                (document) => `https://${document.host}/door/${EXTENSION_ID}/catalog`,
                // allow(silent-catch): a daemon from before 2.60.0 names no identity; the tab then shows no address
                () => undefined,
            );
            const waiting = logs.drafts().map((draft) => ({
                id: draft.id,
                kind: draft.kind,
                headline: draft.record?.headline ?? `entry ${draft.target ?? `?`}`,
                createdAt: draft.createdAt,
                cosign: draft.cosign,
            }));
            const overview: Publishing = { size: logs.size(), published: logs.published(50), waiting };
            if (catalogUrl !== undefined) {
                overview.catalogUrl = catalogUrl;
            }
            return overview;
        },
        draftPublish: async (input: DraftInput): Promise<Draft> => {
            const record = await recordOf(deps, input);
            const draft: Draft = { id: `network-${randomBytes(6).toString(`hex`)}`, kind: `publish`, digest: publishDigest(record), record, cosign: await deps.cosignMode(), createdAt: deps.now() };
            const details = [`Publishes this record to this sandbox's public Network log, signed with its key. Anyone can read and verify it; withdrawing it later erases the text but leaves a trace that something was withdrawn.`, ``, `**${record.headline}**`, ``, record.text ?? record.articleBody ?? ``, ``, `Digest: \`${draft.digest}\``].join(`\n`);
            return fileDraft(draft, `Publish to the Network: ${record.headline.slice(0, 150)}`, details);
        },
        draftWithdraw: async (seq: number): Promise<Draft> => {
            const entry = logs.entry(seq);
            if (entry === undefined || entry.entry.record === undefined) {
                throw new Error(`entry ${seq} is not a published record that can be withdrawn`);
            }
            const draft: Draft = { id: `network-${randomBytes(6).toString(`hex`)}`, kind: `withdraw`, digest: withdrawDigest(seq), target: seq, cosign: await deps.cosignMode(), createdAt: deps.now() };
            return fileDraft(draft, `Withdraw from the Network: ${entry.entry.record.headline.slice(0, 150)}`, `Erases entry ${seq}'s text from this sandbox's log and appends a signed note that it was withdrawn. Copies others already took are not recalled.`);
        },
        // The approvals queue's hand-over, after a person's yes was matched and spent.
        perform: async (action: ApprovedAction): Promise<ApprovedActionOutcome> => {
            const draft = logs.draft(action.id);
            if (draft === undefined) {
                return refused(`this Network draft is not known here any more`);
            }
            if (draft.doneSeq !== undefined) {
                return { outcome: `done`, result: `entry ${draft.doneSeq}` };
            }
            const problem = await approvalProblem(draft, action, (await identity.document()).sandbox);
            if (problem !== undefined) {
                return refused(problem);
            }
            const seq = await append(draft.kind === `publish` ? { record: draft.record, cosign: action.cosign } : { tombstoneOf: draft.target, cosign: action.cosign });
            logs.markDone(draft.id, seq);
            return { outcome: `done`, result: `entry ${seq}` };
        },
    };
};

export type Publisher = ReturnType<typeof createPublisher>;
