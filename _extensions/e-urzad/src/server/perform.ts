import type { ApprovedAction, ApprovedActionHandler, ApprovedActionOutcome, ExtensionServerApi, ServerDocument, StoredJson } from "@intentic/extension-api";
import { z } from "zod";
import { perform, type PerformOptions, StillPending } from "../actions.js";
import { loadApproved, type LoadedOperation, Refused } from "../core/approved-operation.js";
import { edFromConfig, ezdFromConfig, type Service } from "../core/cards.js";
import { ruleFor } from "../core/guard.js";
import { edScope, ezdScope, type OfficeScope, scopeChanges } from "../core/scope.js";
import type { JsonObject } from "../core/json.js";
import { OfficeRecords } from "../core/records.js";
import { EdClient } from "../ed/mailbox.js";
import { EzdClient } from "../ezd/integrator.js";
import { causeText } from "../signatures/engine.js";

// An approved office act, carried out here in the backend and nowhere else. The daemon's approvals executor hands an item
// over only after it matched the person's recorded yes against the item and spent it; this then holds the act to that
// yes on its own side before anything reaches the office:
//   1. the operation and its file copies are read once and the digest recomputed over those bytes (core/approved-operation.ts);
//   2. the action rules, as the daemon reads them now, may still deny the key;
//   3. the card is read from the daemon (credentials included, never from the agent's environment), and its whole
//      destination and acting identity (core/scope.ts: addresses, position, user, mailbox, system) must still be the
//      one the person approved;
//   4. one attempt per yes, journalled in the extension's own state before the office is called, so the same yes handed
//      over twice, or twice at once, is carried out at most once.
// Anything that stops it before step 4 is a refusal: nothing reached the office. Anything that fails after is uncertain,
// since the office may have taken all or part of it, and the queue never repeats it by itself.

const ServiceSchema = z.enum(["ezd-rp", "e-doreczenia"]);

// One attempt per yes, by the approval's id and the moment of its yes: a retry from the app is a new yes, a later
// `approvedAt`, and may run; the same yes again may not.
const AttemptSchema = z.object({
    key: z.string(),
    approvalId: z.string(),
    approvedAt: z.number(),
    approver: z.string().optional(),
    digest: z.string(),
    startedAt: z.string(),
    outcome: z.enum(["started", "done", "uncertain"]),
    detail: z.string().optional(),
});
type Attempt = z.infer<typeof AttemptSchema>;
const AttemptsSchema = z.object({ attempts: z.array(AttemptSchema) });
type Attempts = z.infer<typeof AttemptsSchema>;

// Enough to recognise a replay of any yes the queue could still hand over; the office's own record is the archive.
const KEPT_ATTEMPTS = 500;

export const ATTEMPTS_FILE = "approved-attempts.json";

export const openAttempts = (api: Pick<ExtensionServerApi, "document">): ServerDocument<Attempts> =>
    api.document<Attempts>(ATTEMPTS_FILE, {
        parse: (raw: StoredJson) => AttemptsSchema.safeParse(raw).data,
        fallback: () => ({ attempts: [] }),
    });

const attemptKey = (action: ApprovedAction): string => `${action.id}@${String(action.approvedAt)}`;

const refused = (error: string): ApprovedActionOutcome => ({ outcome: "refused", error });

// The office's answer as the row's one line.
const resultLine = (answer: JsonObject): string => {
    const text = JSON.stringify(answer);
    return text.length > 1000 ? `${text.slice(0, 999)}…` : text;
};

interface Prepared {
    readonly loaded: LoadedOperation;
    readonly service: Service;
    readonly records: OfficeRecords;
    readonly clients: { readonly ezd?: EzdClient; readonly ed?: EdClient };
}

// Steps 1 to 3: what will be sent, whether it may be, and the connection it goes through.
const prepare = async (api: ExtensionServerApi, action: ApprovedAction): Promise<Prepared> => {
    const loaded = await loadApproved(api.workspaceRoot, action);
    const { operation } = loaded;
    if (ruleFor(action.actionRules, operation.key) === "deny") {
        throw new Refused(`${operation.key} is refused by this sandbox's action rules`);
    }
    const read = await api.daemon.rpc.capabilities.connection({ id: operation.card }).catch((cause: Error) => {
        throw new Refused(`the card "${operation.card}" cannot be read (${causeText(cause)})`);
    });
    const service = ServiceSchema.safeParse(read.config["provider"]);
    if (read.kind !== "cli" || !service.success) {
        throw new Refused(`"${operation.card}" is no longer a connected EZD RP or e-Doręczenia card`);
    }
    const records = new OfficeRecords(api.workspaceRoot, operation.card, service.data);
    // The whole destination and acting identity, recomputed from the card as the daemon holds it now: a card edited in
    // any field of it since the yes refuses, however little the edit looks like a different office.
    const sameScope = (now: OfficeScope): void => {
        const changes = scopeChanges(operation.scope, now);
        if (changes.length > 0) {
            throw new Refused(`the card "${operation.card}" changed since this was approved (${changes.join("; ")})`);
        }
    };
    try {
        if (service.data === "ezd-rp") {
            const settings = ezdFromConfig(operation.card, read.config);
            sameScope(ezdScope(settings));
            return { loaded, service: service.data, records, clients: { ezd: new EzdClient(settings) } };
        }
        const settings = edFromConfig(operation.card, read.config);
        sameScope(edScope(settings));
        return { loaded, service: service.data, records, clients: { ed: new EdClient(settings) } };
    } catch (cause) {
        // A card that no longer builds a client (an address that is not https, a field emptied) is refused like a moved one.
        throw cause instanceof Refused ? cause : new Refused(causeText(cause));
    }
};

// Step 4's claim: the attempt is written before the office is called, in one serialized update, and a yes already in
// the journal is refused. Answers whether this call holds the attempt.
const claimAttempt = async (attempts: ServerDocument<Attempts>, action: ApprovedAction, prepared: Prepared): Promise<Attempt | undefined> => {
    const key = attemptKey(action);
    let claimed: Attempt | undefined;
    await attempts.update((current) => {
        claimed = undefined;
        if (current.attempts.some((attempt) => attempt.key === key)) {
            return current;
        }
        claimed = {
            key,
            approvalId: action.id,
            approvedAt: action.approvedAt,
            approver: action.approver,
            digest: prepared.loaded.digest,
            startedAt: new Date().toISOString(),
            outcome: "started",
        };
        return { attempts: [claimed, ...current.attempts].slice(0, KEPT_ATTEMPTS) };
    });
    return claimed;
};

const settleAttempt = async (attempts: ServerDocument<Attempts>, key: string, outcome: Attempt["outcome"], detail: string): Promise<void> => {
    await attempts.update((current) => ({ attempts: current.attempts.map((attempt) => (attempt.key === key ? { ...attempt, outcome, detail: detail.slice(0, 500) } : attempt)) }));
};

export const approvedPerformer = (api: ExtensionServerApi, options: PerformOptions = {}): ApprovedActionHandler => {
    const attempts = openAttempts(api);
    return async (action) => {
        let prepared: Prepared;
        try {
            prepared = await prepare(api, action);
        } catch (cause) {
            return refused(causeText(cause));
        }
        const attempt = await claimAttempt(attempts, action, prepared);
        if (attempt === undefined) {
            return refused(`approval ${action.id} was already attempted on this yes; it is never carried out twice, and nothing was sent again`);
        }
        const { operation } = prepared.loaded;
        try {
            const answer = await perform(prepared.loaded, prepared.clients, prepared.records, options);
            await settleAttempt(attempts, attempt.key, "done", resultLine(answer));
            await prepared.records.recordAction({
                at: new Date().toISOString(),
                key: operation.key,
                approvalId: action.id,
                approvedBy: action.approver,
                outcome: operation.summary,
            });
            return { outcome: "done", result: resultLine(answer) };
        } catch (cause) {
            const error = cause instanceof StillPending ? cause.message : `${causeText(cause)}. The office may have received all or part of it`;
            await settleAttempt(attempts, attempt.key, "uncertain", error);
            return { outcome: "uncertain", error };
        }
    };
};
