import { RelinkAnswerSchema, type RelinkAnswer, type RelinkRequest } from "@intentic/sandbox-contract";
import { z } from "zod";
import { apiClient } from "../../../lib/useApi";
import { useSandbox } from "../client/useSandbox";
import { useSandboxSession } from "../session/sandboxSession";
import { forgetSandbox, missingSandboxes, type RememberedSandbox } from "./deviceDirectory";
import { sandboxAt } from "./directMode";
import type { RecoveryDeps } from "./useRecovery";

// The recovery screen's dependencies against the real world: the daemon's own doors for the sandbox (/health, POST
// /platform/relink, both straight from this browser), the platform's for the account (lookup, adoption ticket).

// Long enough for a tunnel's first answer; a sandbox that takes longer reads as not answering, and the reader checks again.
const HEALTH_BUDGET_MS = 10_000;
// A Reconnect waits on the daemon waiting on the platform twice (adopt, then announce), each bounded by a quiet minute
// on the daemon's side; this only stops a dead tunnel from holding the button forever.
const RELINK_BUDGET_MS = 150_000;

const HealthSchema = z.object({ sandboxId: z.string().optional() });
const RefusalSchema = z.object({ error: z.string() });

const health = async (daemonUrl: string): Promise<{ readonly sandboxId: string | undefined } | undefined> => {
    try {
        const response = await fetch(`${daemonUrl}/health`, { cache: `no-store`, signal: AbortSignal.timeout(HEALTH_BUDGET_MS) });
        if (!response.ok) {
            return undefined;
        }
        const parsed = HealthSchema.safeParse(await response.json());
        return { sandboxId: parsed.success ? parsed.data.sandboxId : undefined };
    } catch {
        // allow(silent-catch): DNS, TLS, CORS and a dead tunnel all mean the same thing here: nothing answers.
        return undefined;
    }
};

// A daemon from before Reconnect answers the route it does not serve with a 404, which is the attach fallback's cue.
const relink = async (entry: RememberedSandbox, bearer: string, request: RelinkRequest): Promise<RelinkAnswer | `unsupported`> => {
    const response = await fetch(`${entry.daemonUrl}/platform/relink`, {
        method: `POST`,
        headers: { authorization: `Bearer ${bearer}`, "content-type": `application/json` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(RELINK_BUDGET_MS),
    });
    if (response.status === 404) {
        return `unsupported`;
    }
    // allow(silent-catch): a body that is not JSON is a refusal without a reason, named by its status below.
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
        const refusal = RefusalSchema.safeParse(body);
        throw new Error(refusal.success ? refusal.data.error : `the sandbox answered ${response.status}`);
    }
    return RelinkAnswerSchema.parse(body);
};

// For one account, and the address an /open link named when there was one (it joins the candidates if it is not one).
export const liveRecoveryDeps = (email: string, url: string | undefined): RecoveryDeps => {
    const { getSessionToken } = useSandboxSession();
    const { create, attach, refresh } = useSandbox();
    return {
        candidates: () => {
            const missing = missingSandboxes(email);
            return url === undefined || missing.some((entry) => entry.daemonUrl === url) ? missing : [...missing, sandboxAt(url)];
        },
        health,
        lookup: async (sandboxIds) => (await apiClient.sandbox.lookup({ sandboxIds: [...sandboxIds] })).sandboxes,
        ticket: (sandboxId) => apiClient.sandbox.adoptionTicket({ sandboxId }),
        // Keyed by the row id the platform last listed it under, so a session this browser still holds is spent first.
        bearer: async (entry) => (await getSessionToken({ sandboxId: entry.id, base: entry.daemonUrl, connectToken: undefined }))?.token,
        relink,
        attach: async (entry) => {
            const row = await create(entry.name);
            await attach(row.id, entry.daemonUrl);
        },
        refreshList: () => refresh(),
        forget: (entry) => forgetSandbox(email, entry.daemonUrl),
    };
};
