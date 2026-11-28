import { rm } from "node:fs/promises";
import { join } from "node:path";
import { keyedLock } from "@intentic/base/async";
import { normalizeProjectId } from "@intentic/sandbox-contract/project-id";
import { type AccountProblem, AccountProblemSchema, type AccountReport } from "@intentic/sandbox-contract/schemas/issues";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { SANDBOX_PASS_HEADER } from "@intentic/sandbox-contract/sandbox-pass";
import { parseJsonOr } from "@intentic/base/json";
import type { Logger } from "pino";
import { z } from "zod";
import { type Delivery, type RouteClient, type RouteRequest, routeClientOf, type RouteTarget, tooOld } from "./route-client.js";
import type { Services } from "../composition.js";
import { stateRelPath } from "../state-paths.js";
import { pinDefault } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { defineStep } from "../store/evolution/state-steps.js";
import { openDirectory } from "../store/open-document.js";
import { fingerprintOf } from "./report-fingerprint.js";
import { type ReportOverS2s, reportOverS2s } from "./messages/report-over-s2s.js";

export type { Delivery } from "./route-client.js";

// ACCOUNT-LEVEL ROUTING, the sending half's outbox: what this sandbox hands another one of the account (a report about a
// project that sandbox claims, a drop into a person's inbox there) waits here until it lands. The platform is asked where
// it goes (account-routing/route-client.ts, a directory and a notary, never a mailbox); it then goes straight to that
// sandbox's daemon under the pass the platform signed. Sandboxes sleep and go offline, so what cannot be delivered now
// waits, one file per entry: a repeated report folds into a count rather than another file, and each is retried with a
// growing wait until it lands or a week has passed. A report to a sandbox that speaks s2s/1 goes on as a message
// (messages/report-over-s2s.ts), and the messages outbox keeps it from there.
//
// On the history volume since 2026-11-24, out of every turn's reach. In the workspace (`.intentic/records/outbox/`) an
// agent could rewrite a queued entry before it drained, and the drain sent whatever the file said under this sandbox's
// pass: another project, another body, a person it never acted for.

const CommonSchema = z.object({
    // The one person it routes as: on a drop always, on a report only as attribution.
    person: z.string().optional(),
    // The conversation that sent it, as the send proved it.
    conversationId: z.string().optional(),
    times: z.number().int().min(1),
    firstAt: z.number(),
    attempts: z.number().int().min(0),
    nextAt: z.number(),
    // Why the last try did not land, in words the agent and the owner read.
    lastError: z.string().optional(),
});

// A problem for whichever sandbox claims `project`, filed into its issues inbox.
const ReportEntrySchema = CommonSchema.extend({ kind: z.literal("report"), project: z.string(), report: AccountProblemSchema });
// A note and files into the person's inbox at `target` (a sandbox's name or id, as the sender named it). The files wait
// in `staged`, a directory under <history>/account-outbox-staged/ (stagedDirOf), removed with the entry. Delivered by the
// `drop` deliverer the inbox side registers; until one is, a drop waits.
const DropEntrySchema = CommonSchema.extend({
    kind: z.literal("drop"),
    target: z.string(),
    person: z.string(),
    note: z.string().optional(),
    staged: z.string().optional(),
    // The conversation of the person's there to queue its note into, besides the inbox (a conversation id there).
    wake: z.string().optional(),
});

export const accountOutboxDocument = defineDocument({
    root: "history",
    path: "account-outbox/",
    // Undelivered sends are the workspace's, and a moved sandbox should still send them, as they did from the workspace.
    portability: "carry",
    directory: true,
    schema: z.discriminatedUnion("kind", [ReportEntrySchema, DropEntrySchema]),
    // Every entry before 2026-11-24 was a report and said nothing of its kind.
    history: [pinDefault("kind", "report")],
});
export type OutboxEntry = z.infer<typeof accountOutboxDocument.schema>;
export type ReportEntry = Extract<OutboxEntry, { kind: "report" }>;
export type DropEntry = Extract<OutboxEntry, { kind: "drop" }>;
// What a sender hands the outbox: the entry without its bookkeeping, which the outbox keeps.
export type DropDraft = Omit<DropEntry, "times" | "firstAt" | "attempts" | "nextAt" | "lastError">;

/** Where a drop's files wait until it lands, by the name its entry's `staged` holds. */
export const stagedDirOf = (historyRoot: string, staged: string): string => join(historyRoot, "account-outbox-staged", staged);

// How long a send waits for its sandbox to come back before it is let go.
export const OUTBOX_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const DELIVER_MS = 15_000;
// Bounded like the issues inbox: a loop reporting a fresh problem each time cannot fill the disk.
const OUTBOX_MAX = 500;

// What one send came to, as the CLI tells the agent.
export type SendOutcome =
    | { readonly state: "delivered"; readonly to: string; readonly id: string }
    | { readonly state: "queued"; readonly to?: string; readonly reason: string; readonly times: number }
    | { readonly state: "refused"; readonly reason: string };

// What one try came to: refused for good, not resolved (try later), or a delivery attempt with its answer.
type Tried =
    | { readonly kind: "refused"; readonly reason: string }
    | { readonly kind: "unresolved"; readonly reason: string }
    | { readonly kind: "tried"; readonly target: RouteTarget; readonly delivery: Delivery };

// One try at the far side for each kind of entry: the hook a kind's sender registers. A drop with no deliverer waits.
export interface OutboxDeliverers {
    readonly report: (target: RouteTarget, body: AccountReport, entry: ReportEntry) => Promise<Delivery>;
    readonly drop?: (target: RouteTarget, entry: DropEntry, id: string) => Promise<Delivery>;
}

export interface OutboxDeps {
    readonly dir: string;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly route: Pick<RouteClient, "deliverRouted">;
    readonly deliver: OutboxDeliverers;
    // Called once an entry is gone, delivered, refused or let go: a drop's staged files go with it.
    readonly removed?: (id: string, entry: OutboxEntry) => Promise<void>;
    readonly now?: () => number;
}

const AnswerSchema = z.object({ id: z.string().optional(), error: z.string().optional(), code: z.string().optional() });

/** One POST to a receiving daemon's door through the edge; a redirect is refused, so a pass never travels anywhere else. */
export const postToDoor = async <Body extends object>(
    target: RouteTarget,
    path: string,
    body: Body,
    headers: Readonly<Record<string, string>> = {},
): Promise<Delivery> => {
    try {
        const response = await fetch(new URL(path, target.address), {
            method: "POST",
            headers: { "content-type": "application/json", [SANDBOX_PASS_HEADER]: target.pass, ...headers },
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.timeout(DELIVER_MS),
        });
        const text = await response.text();
        const answer = AnswerSchema.safeParse(parseJsonOr(text, undefined)).data;
        if (answer === undefined) {
            return { status: response.status, error: text.includes("no-tunnel") ? "it is not online" : `it answered ${response.status}` };
        }
        return { status: response.status, ...answer };
    } catch {
        // allow(silent-catch): a sandbox that does not answer at all is the commonest case here, said as status 0.
        return { status: 0, error: "it did not answer" };
    }
};

// A report goes as a message where the target speaks s2s/1 (messages/report-over-s2s.ts), and to its account door otherwise.
export const reportDeliveryOf =
    (overS2s: ReportOverS2s | undefined): OutboxDeliverers["report"] =>
    async (target, body, entry) =>
        (await overS2s?.(target, entry)) ?? postToDoor(target, rawRouteUrl("POST /account/report"), body);

// Whether a try that did not land is worth another later, or the far side refused this entry for good.
const retryable = (delivery: Delivery): boolean =>
    delivery.status === 0 || delivery.status === 404 || delivery.status === 429 || delivery.status >= 500 || tooOld(delivery);

// A repo's remote inside this sandbox is the credential broker's loopback address (capabilities/broker/broker-session.ts:
// `http://127.0.0.1:<port>/<payload>.<signature>/owner/repo.git`), whose payload names the real upstream. Read for the
// project's name only, never verified or used to reach anything, so an agent can pass `git remote get-url origin` as is.
const BROKERED = /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\/(.+)$/;
const BrokerPayloadSchema = z.object({ u: z.string() });
export const projectOfRemote = (raw: string): string | undefined => {
    const brokered = BROKERED.exec(raw.trim());
    if (brokered === null) {
        return normalizeProjectId(raw);
    }
    const payload = BrokerPayloadSchema.safeParse(parseJsonOr(Buffer.from(brokered[1] ?? "", "base64url").toString("utf8"), undefined));
    return payload.success ? normalizeProjectId(`${payload.data.u.replace(/\/+$/, "")}/${brokered[2] ?? ""}`) : undefined;
};

const waitAfter = (attempts: number): number => Math.min(RETRY_FIRST_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);

// What the platform is asked for an entry: a report by its project, a drop by its target, each as its person.
const requestOf = (entry: OutboxEntry): RouteRequest =>
    entry.kind === "report" ? { scope: "report", project: entry.project, person: entry.person } : { scope: "drop", sandbox: entry.target, person: entry.person };

const reportBody = (entry: ReportEntry): AccountReport => {
    const body: AccountReport = { report: entry.report, times: entry.times };
    if (entry.conversationId !== undefined) {
        body.conversationId = entry.conversationId;
    }
    return body;
};

// One try through the route client, which asks for a fresh pass once when the far side refuses the one it got.
const attempt = async (deps: Pick<OutboxDeps, "route" | "deliver">, id: string, entry: OutboxEntry): Promise<Tried> => {
    const drop = deps.deliver.drop;
    const send =
        entry.kind === "report" ? (target: RouteTarget) => deps.deliver.report(target, reportBody(entry), entry) : drop && ((target: RouteTarget) => drop(target, entry, id));
    if (send === undefined) {
        return { kind: "unresolved", reason: "this build cannot deliver a drop yet" };
    }
    const routed = await deps.route.deliverRouted(requestOf(entry), send);
    if (!routed.routed) {
        const { status, message } = routed.answer;
        return status === 0 || status >= 500 ? { kind: "unresolved", reason: message } : { kind: "refused", reason: message };
    }
    return { kind: "tried", target: routed.target, delivery: routed.delivery };
};

// Why a try that did not land is still waiting, in the words the agent and the owner read.
const waitingBecause = (entry: OutboxEntry, tried: Exclude<Tried, { kind: "refused" }>): string => {
    if (tried.kind === "unresolved") {
        return entry.kind === "report" ? `the platform could not say who claims ${entry.project}: ${tried.reason}` : `the platform could not say where ${entry.target} is: ${tried.reason}`;
    }
    return tooOld(tried.delivery)
        ? `${tried.target.name} runs a build too old to take ${entry.kind === "report" ? "reports" : "drops"}: updating that sandbox brings it`
        : `${tried.target.name}: ${tried.delivery.error ?? "did not take it"}`;
};

// A try the far side took: delivered, or gone on as a message the messages outbox keeps trying, which is what waits now.
const landed = (id: string, entry: OutboxEntry, tried: Extract<Tried, { kind: "tried" }>): SendOutcome =>
    tried.delivery.handedOn === undefined
        ? { state: "delivered", to: tried.target.name, id: tried.delivery.id ?? id }
        : { state: "queued", to: tried.target.name, reason: tried.delivery.handedOn, times: entry.times };

export const createAccountOutbox = (deps: OutboxDeps) => {
    const files = openDirectory(accountOutboxDocument, deps.dir);
    const now = deps.now ?? Date.now;
    const serialize = keyedLock<string>();

    const remove = async (id: string, entry: OutboxEntry): Promise<void> => {
        await files.remove(id);
        await deps.removed?.(id, entry);
    };

    const settle = async (id: string, entry: OutboxEntry): Promise<SendOutcome> => {
        const tried = await attempt(deps, id, entry);
        if (tried.kind === "refused") {
            await remove(id, entry);
            return { state: "refused", reason: tried.reason };
        }
        if (tried.kind === "tried" && tried.delivery.status === 200) {
            await remove(id, entry);
            return landed(id, entry, tried);
        }
        if (tried.kind === "tried" && !retryable(tried.delivery)) {
            await remove(id, entry);
            return { state: "refused", reason: `${tried.target.name} refused it: ${tried.delivery.error ?? tried.delivery.status}` };
        }
        const reason = waitingBecause(entry, tried);
        const attempts = entry.attempts + 1;
        await files.write(id, { ...entry, attempts, nextAt: now() + waitAfter(attempts), lastError: reason });
        return tried.kind === "tried" ? { state: "queued", to: tried.target.name, reason, times: entry.times } : { state: "queued", reason, times: entry.times };
    };

    const full = async (id: string): Promise<boolean> => (await files.read(id)) === undefined && (await files.list()).entries.length >= OUTBOX_MAX;
    const FULL = `${OUTBOX_MAX} sends are already waiting to be delivered: let those land first`;

    // Sends a report now, or keeps it for later; one already waiting about the same problem folds into it.
    const send = async (
        rawProject: string,
        report: AccountProblem,
        from: { readonly conversationId?: string | undefined; readonly person?: string | undefined } = {},
    ): Promise<SendOutcome> => {
        const project = projectOfRemote(rawProject);
        if (project === undefined) {
            return { state: "refused", reason: `"${rawProject}" names no repository: give it as github.com/owner/repo` };
        }
        const id = fingerprintOf(`outbox\u0000${project}`, report, crypto.randomUUID());
        return serialize(id, async () => {
            if (await full(id)) {
                return { state: "refused", reason: FULL };
            }
            const waiting = await files.read(id);
            const at = now();
            const next: ReportEntry = { kind: "report", project, report, times: 1, firstAt: at, attempts: 0, nextAt: at };
            if (waiting?.kind === "report") {
                const { id: _id, ...kept } = waiting;
                Object.assign(next, kept, { report, times: kept.times + 1 });
            }
            // The latest sender's word on who sent it: a repeat from nobody in particular names nobody.
            Object.assign(next, { conversationId: from.conversationId, person: from.person });
            for (const key of ["conversationId", "person"] as const) {
                if (next[key] === undefined) {
                    delete next[key];
                }
            }
            return settle(id, next);
        });
    };

    // Sends a drop now, or keeps it for later, under its own id (a drop never folds into another).
    const sendDrop = async (id: string, draft: DropDraft): Promise<SendOutcome> =>
        serialize(id, async () => {
            if (await full(id)) {
                return { state: "refused", reason: FULL };
            }
            const at = now();
            return settle(id, { ...draft, times: 1, firstAt: at, attempts: 0, nextAt: at });
        });

    // Retries what is due, and lets go of what has waited a week.
    const drain = async (): Promise<void> => {
        const { entries } = await files.list();
        const at = now();
        for (const { id, ...entry } of entries) {
            if (at - entry.firstAt > OUTBOX_KEEP_MS) {
                await remove(id, entry);
                deps.logger.warn({ kind: entry.kind, times: entry.times, lastError: entry.lastError }, "account send let go after a week undelivered");
                continue;
            }
            if (entry.nextAt <= at) {
                const outcome = await serialize(id, async () => {
                    const current = await files.read(id);
                    return current === undefined ? undefined : settle(id, entry);
                });
                if (outcome?.state === "delivered") {
                    deps.logger.info({ kind: entry.kind, to: outcome.to, times: entry.times }, "account send delivered from the outbox");
                }
            }
        }
    };

    return { send, sendDrop, drain, list: async () => (await files.list()).entries };
};

export type AccountOutbox = ReturnType<typeof createAccountOutbox>;

// The drop deliverer the inbox side registers, once, before the first drain; until then a drop waits in the outbox.
// allow(module-state): one hook per daemon process, set by the module that owns drops.
let dropDeliverer: OutboxDeliverers["drop"];
export const registerDropDelivery = (deliver: NonNullable<OutboxDeliverers["drop"]>): void => {
    dropDeliverer = deliver;
};

// One outbox per daemon: the `projects` routes send through it, and the boot schedulers drain it.
// allow(module-state): one outbox per daemon's services, shared by its routes and its drain.
const outboxes = new WeakMap<Services, AccountOutbox>();

export const accountOutboxOf = (services: Services): AccountOutbox => {
    const known = outboxes.get(services);
    if (known !== undefined) {
        return known;
    }
    const historyRoot = services.config.historyRoot;
    const outbox = createAccountOutbox({
        dir: join(historyRoot, accountOutboxDocument.path),
        logger: services.logger,
        route: routeClientOf(services),
        deliver: {
            report: reportDeliveryOf(reportOverS2s({ s2s: services.s2s, fetch: (url, init) => fetch(url, init), logger: services.logger })),
            drop: async (target, entry, id) => (dropDeliverer === undefined ? { status: 0, error: "this build cannot deliver a drop yet" } : dropDeliverer(target, entry, id)),
        },
        removed: async (_id, entry) => {
            if (entry.kind === "drop" && entry.staged !== undefined) {
                await rm(stagedDirOf(historyRoot, entry.staged), { recursive: true, force: true });
            }
        },
    });
    outboxes.set(services, outbox);
    return outbox;
};

const OUTBOX_DRAIN_MS = 60_000;

// Retries what is due once a minute; unref'd, so it never holds the daemon up. Answers its stop.
export const startAccountOutbox = (services: Services): (() => void) => {
    const outbox = accountOutboxOf(services);
    const tick = (): void => {
        void outbox.drain().catch((error: Error) => services.logger.warn({ err: error }, "account outbox drain failed"));
    };
    const timer = setInterval(tick, OUTBOX_DRAIN_MS);
    timer.unref();
    tick();
    return () => clearInterval(timer);
};

// The outbox as releases before 2026-11-24 kept it, in the workspace, where a turn writes as freely as the daemon.
const LEGACY_DIR = stateRelPath(".intentic/records/outbox/");
// Not an entry: the outbox lists `.json` files only, so this marks a directory that was started empty.
const MOVED_MARK = ".moved-from-workspace";

// Brings the outbox to the history volume, every file as it is: the document's own conversion names the kind of an entry
// from before drops (every one a report) on its first read. The workspace copies are removed, since a copy left behind
// would be sent twice by a rollback to a build that still read it (the update's journal keeps them until it commits).
// One-shot: the directory existing on the history volume is what says this ran, so a file written at the old address
// later is never brought over.
export const accountOutboxOffWorkspaceStep = defineStep({
    id: "account-outbox-off-workspace",
    describe: "moves the account outbox from the workspace to the history volume",
    plan: async ({ roots, kind, list, read }) => {
        const target = join(roots.history, accountOutboxDocument.path);
        if ((await kind(target)) !== undefined) {
            return undefined;
        }
        const legacy = join(roots.workspace, LEGACY_DIR);
        const names = (await kind(legacy)) === "directory" ? (await list(legacy)).filter((name) => name.endsWith(".json")) : [];
        const writes = new Map<string, string | undefined>();
        for (const name of names) {
            const text = await read(join(legacy, name));
            if (text !== undefined) {
                writes.set(join(target, name), text);
                writes.set(join(legacy, name), undefined);
            }
        }
        const moved = writes.size / 2;
        // An empty outbox still starts its directory, which is what marks the move as done.
        if (moved === 0) {
            writes.set(join(target, MOVED_MARK), "");
        }
        return {
            changes: [
                moved === 0
                    ? `starts ${accountOutboxDocument.path} on the history volume with nothing waiting`
                    : `moves ${moved} waiting send(s) from ${LEGACY_DIR} to ${accountOutboxDocument.path} on the history volume`,
            ],
            writes,
        };
    },
});
