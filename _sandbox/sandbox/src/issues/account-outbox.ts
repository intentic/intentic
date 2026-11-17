import { join } from "node:path";
import { keyedLock } from "@intentic/base/async";
import { ProjectResolvedSchema, type ProjectResolved } from "@intentic/api-contract/ingress";
import { normalizeProjectId } from "@intentic/sandbox-contract/project-id";
import { type AccountProblem, AccountProblemSchema, type AccountReport } from "@intentic/sandbox-contract/schemas/issues";
import { SANDBOX_PASS_HEADER } from "@intentic/sandbox-contract/sandbox-pass";
import { parseJsonOr } from "@intentic/base/json";
import type { Logger } from "pino";
import { z } from "zod";
import type { Services } from "../composition.js";
import type { Config } from "../env.config.js";
import { stateRelPath } from "../state-paths.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDirectory } from "../store/open-document.js";
import { callPlatform } from "../system/platform-relay.js";
import { fingerprintOf } from "./fingerprint.js";

// ACCOUNT-LEVEL REPORT ROUTING, the sending half: this sandbox telling the one on the same account that claims a project
// about a problem it saw. The platform is asked who that is (a directory and a notary, never a mailbox); the report then
// goes straight to that sandbox's daemon under the pass it signed (account.routes.ts over there). Sandboxes sleep and
// go offline, so what cannot be delivered now waits here, one file per problem: a repeat while it waits folds into a
// count rather than another file, and it is retried with a growing wait until it lands or a week has passed.

export const outboxDocument = defineDocument({
    path: stateRelPath(".intentic/records/outbox/"),
    directory: true,
    schema: z.object({
        project: z.string(),
        report: AccountProblemSchema,
        conversationId: z.string().optional(),
        times: z.number().int().min(1),
        firstAt: z.number(),
        attempts: z.number().int().min(0),
        nextAt: z.number(),
        // Why the last try did not land, in words the agent and the owner read.
        lastError: z.string().optional(),
    }),
});
export type OutboxEntry = z.infer<typeof outboxDocument.schema>;

// How long a report waits for its sandbox to come back before it is let go.
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

// One try at the far side: the receiving daemon's answer, or `status` 0 for no answer at all.
export interface Delivery {
    readonly status: number;
    readonly error?: string | undefined;
    readonly id?: string | undefined;
}

// What one try came to: refused for good, not resolved (try later), or a delivery attempt with its answer.
type Tried =
    | { readonly kind: "refused"; readonly reason: string }
    | { readonly kind: "unresolved"; readonly reason: string }
    | { readonly kind: "tried"; readonly target: ProjectResolved; readonly delivery: Delivery };

export interface OutboxDeps {
    readonly dir: string;
    readonly logger: Pick<Logger, "info" | "warn">;
    // Who claims the project: the platform's answer, or why there is none (status 0 for an unreachable platform).
    readonly resolve: (project: string) => Promise<{ ok: true; value: ProjectResolved } | { ok: false; status: number; message: string }>;
    readonly deliver: (target: ProjectResolved, body: AccountReport) => Promise<Delivery>;
    readonly now?: () => number;
}

const AnswerSchema = z.object({ id: z.string().optional(), error: z.string().optional() });

// The platform's directory, through the relay every connect-token route uses.
const platformResolver =
    (config: Config): OutboxDeps["resolve"] =>
    async (project) => {
        const answer = await callPlatform(config, { route: "projectResolve", input: { project }, unreached: "nothing was sent" });
        const parsed = parseJsonOr(answer.body, undefined);
        if (answer.status === 200) {
            const value = ProjectResolvedSchema.safeParse(parsed);
            return value.success ? { ok: true, value: value.data } : { ok: false, status: 502, message: "the platform answered in a shape this build does not read" };
        }
        const error = AnswerSchema.safeParse(parsed).data?.error;
        return { ok: false, status: answer.status === 502 ? 0 : answer.status, message: error ?? `the platform answered ${answer.status}` };
    };

// Straight to the receiving daemon through the edge; a redirect is refused, so a pass never travels anywhere else.
const directDelivery: OutboxDeps["deliver"] = async (target, body) => {
    try {
        const response = await fetch(new URL("/account/report", target.address), {
            method: "POST",
            headers: { "content-type": "application/json", [SANDBOX_PASS_HEADER]: target.pass },
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

// A daemon older than this door refuses it as a sign-in it does not know: the bare "unauthorized" every unknown route
// gets, where this door words its own refusals (the same tell link-client.ts reads).
const tooOld = (delivery: Delivery): boolean => delivery.status === 401 && delivery.error === "unauthorized";

// Whether a try that did not land is worth another later, or the far side refused this report for good.
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

// One try, re-resolving once when the far side says the pass is no longer good (it expired, or the claim moved).
const attempt = async (deps: Pick<OutboxDeps, "resolve" | "deliver">, entry: OutboxEntry): Promise<Tried> => {
    const body: AccountReport = { report: entry.report, times: entry.times };
    if (entry.conversationId !== undefined) {
        body.conversationId = entry.conversationId;
    }
    let tried: Tried = { kind: "unresolved", reason: "nothing was tried" };
    for (let round = 0; round < 2; round += 1) {
        const resolved = await deps.resolve(entry.project);
        if (!resolved.ok) {
            return resolved.status === 0 || resolved.status >= 500 ? { kind: "unresolved", reason: resolved.message } : { kind: "refused", reason: resolved.message };
        }
        tried = { kind: "tried", target: resolved.value, delivery: await deps.deliver(resolved.value, body) };
        if (tried.delivery.status !== 401 || tooOld(tried.delivery)) {
            return tried;
        }
    }
    return tried;
};

// Why a try that did not land is still waiting, in the words the agent and the owner read.
const waitingBecause = (entry: OutboxEntry, tried: Exclude<Tried, { kind: "refused" }>): string => {
    if (tried.kind === "unresolved") {
        return `the platform could not say who claims ${entry.project}: ${tried.reason}`;
    }
    return tooOld(tried.delivery)
        ? `${tried.target.name} runs a build too old to take reports: updating that sandbox brings it`
        : `${tried.target.name}: ${tried.delivery.error ?? "did not take it"}`;
};

export const createAccountOutbox = (deps: OutboxDeps) => {
    const files = openDirectory(outboxDocument, deps.dir);
    const now = deps.now ?? Date.now;
    const serialize = keyedLock<string>();

    const settle = async (id: string, entry: OutboxEntry): Promise<SendOutcome> => {
        const tried = await attempt(deps, entry);
        if (tried.kind === "refused") {
            await files.remove(id);
            return { state: "refused", reason: tried.reason };
        }
        if (tried.kind === "tried" && tried.delivery.status === 200) {
            await files.remove(id);
            return { state: "delivered", to: tried.target.name, id: tried.delivery.id ?? id };
        }
        if (tried.kind === "tried" && !retryable(tried.delivery)) {
            await files.remove(id);
            return { state: "refused", reason: `${tried.target.name} refused it: ${tried.delivery.error ?? tried.delivery.status}` };
        }
        const reason = waitingBecause(entry, tried);
        const attempts = entry.attempts + 1;
        await files.write(id, { ...entry, attempts, nextAt: now() + waitAfter(attempts), lastError: reason });
        return tried.kind === "tried" ? { state: "queued", to: tried.target.name, reason, times: entry.times } : { state: "queued", reason, times: entry.times };
    };

    // Sends a report now, or keeps it for later; one already waiting about the same problem folds into it.
    const send = async (rawProject: string, report: AccountProblem, conversationId: string | undefined): Promise<SendOutcome> => {
        const project = projectOfRemote(rawProject);
        if (project === undefined) {
            return { state: "refused", reason: `"${rawProject}" names no repository: give it as github.com/owner/repo` };
        }
        const id = fingerprintOf(`outbox\u0000${project}`, report, crypto.randomUUID());
        return serialize(id, async () => {
            const waiting = await files.read(id);
            if (waiting === undefined && (await files.list()).entries.length >= OUTBOX_MAX) {
                return { state: "refused", reason: `${OUTBOX_MAX} reports are already waiting to be delivered: let those land first` };
            }
            const at = now();
            const next: OutboxEntry = { project, report, times: 1, firstAt: at, attempts: 0, nextAt: at };
            if (waiting !== undefined) {
                const { id: _id, ...kept } = waiting;
                Object.assign(next, kept, { report, times: kept.times + 1 });
            }
            if (conversationId !== undefined) {
                next.conversationId = conversationId;
            }
            return settle(id, next);
        });
    };

    // Retries what is due, and lets go of what has waited a week.
    const drain = async (): Promise<void> => {
        const { entries } = await files.list();
        const at = now();
        for (const { id, ...entry } of entries) {
            if (at - entry.firstAt > OUTBOX_KEEP_MS) {
                await files.remove(id);
                deps.logger.warn({ project: entry.project, times: entry.times, lastError: entry.lastError }, "account report let go after a week undelivered");
                continue;
            }
            if (entry.nextAt <= at) {
                const outcome = await serialize(id, async () => {
                    const current = await files.read(id);
                    return current === undefined ? undefined : settle(id, entry);
                });
                if (outcome?.state === "delivered") {
                    deps.logger.info({ project: entry.project, to: outcome.to, times: entry.times }, "account report delivered from the outbox");
                }
            }
        }
    };

    return { send, drain, list: async () => (await files.list()).entries };
};

export type AccountOutbox = ReturnType<typeof createAccountOutbox>;

const outboxDir = (workspaceRoot: string): string => join(workspaceRoot, outboxDocument.path);

// One outbox per daemon: the `projects` routes send through it, and the boot schedulers drain it.
// allow(module-state): one outbox per daemon's services, shared by its routes and its drain.
const outboxes = new WeakMap<Services, AccountOutbox>();

export const accountOutboxOf = (services: Services): AccountOutbox => {
    const known = outboxes.get(services);
    if (known !== undefined) {
        return known;
    }
    const outbox = createAccountOutbox({
        dir: outboxDir(services.workspace.root),
        logger: services.logger,
        resolve: platformResolver(services.config),
        deliver: directDelivery,
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

