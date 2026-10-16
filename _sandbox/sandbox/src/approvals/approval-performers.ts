import { errnoCode, errorMessage } from "@intentic/base/errors";
import type { ApprovedAction, ApprovedActionOutcome } from "@intentic/extension-api/runtime";
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ActionApprovalSummary } from "@intentic/sandbox-contract";
import { cachedEnabledExtensions } from "../capabilities/contributions.js";
import type { Services } from "../composition.js";
import { approvalRequestBody, ApprovedActionOutcomeSchema } from "../extensions/backend/backend-approvals.js";
import { BACKEND_HOST_HEADER } from "../extensions/backend/backend-host-config.js";
import { backendDown, heldTarget } from "../extensions/backend/extension-mcp.js";
import type { ExtensionHost } from "../extensions/installed-extensions.js";
import type { SpentApproval } from "./approval-decisions.js";

// An approved action that names a `performer`, handed to that extension's backend instead of an agent turn. Called by the
// executor alone, after the person's yes was matched against the item and spent (approval-decisions.ts), so the backend
// host's door (`POST /approvals/<id>`, extensions/backend/backend-host.ts) is reached only with an authorised item. The
// door is behind the host token, which no /x route, panel or agent token carries; the extension holds its credentials
// itself, read from the daemon, and recomputes the digest over what it is about to send.
//
// What comes back keeps three outcomes apart: done; refused, when nothing reached the outside world and a new yes may
// run it again; uncertain, when the request may have reached it, which the queue never retries by itself.

export type PerformerDeps = Pick<Services, "extensionBackend" | "sandboxSettings"> & ExtensionHost;

export type PerformedAction = ActionApprovalSummary & { readonly performer: NonNullable<ActionApprovalSummary["performer"]> };

// How long the door may take: an office upload over a slow link is ordinary, and a call past this is an unknown outcome.
const DOOR_DEADLINE_MS = 10 * 60_000;

const refused = (error: string): ApprovedActionOutcome => ({ outcome: "refused", error });
const uncertain = (error: string): ApprovedActionOutcome => ({ outcome: "uncertain", error });

// The extension the item names, by publisher.name or by the id it is installed under, while it is enabled and has a
// backend to carry anything out.
const performerOf = async (deps: PerformerDeps, name: string): Promise<{ readonly id: string } | undefined> => {
    const found = (await cachedEnabledExtensions(deps)).find((extension) => extensionIdOf(extension.manifest) === name || extension.id === name);
    return found?.manifest.server === undefined ? undefined : { id: found.id };
};

// The outcome the door answered, or the one its silence means.
const outcomeOf = async (answered: Response): Promise<ApprovedActionOutcome> => {
    const text = await answered.text();
    if (answered.ok) {
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            // allow(silent-catch): an answer that is not JSON is no outcome, which the schema refuses just below
            raw = undefined;
        }
        const parsed = ApprovedActionOutcomeSchema.safeParse(raw);
        return parsed.success ? parsed.data : uncertain(`the extension answered something that is not an outcome (${text.slice(0, 200)})`);
    }
    // 400, 401, 404 and 503 are answered before the extension's code runs: nothing was attempted.
    if ([400, 401, 404, 503].includes(answered.status)) {
        return refused(`the extension's backend did not take it (HTTP ${answered.status}: ${text.slice(0, 300)})`);
    }
    return uncertain(`the extension's backend failed while carrying it out (HTTP ${answered.status}: ${text.slice(0, 300)})`);
};

export const performApprovedAction = async (deps: PerformerDeps, item: PerformedAction, yes: SpentApproval): Promise<ApprovedActionOutcome> => {
    const performer = await performerOf(deps, item.performer.extension);
    if (performer === undefined) {
        return refused(`no enabled extension "${item.performer.extension}" with a backend carries this out`);
    }
    const signal = AbortSignal.timeout(DOOR_DEADLINE_MS);
    const backend = await heldTarget(deps.extensionBackend, signal);
    if (backend === undefined) {
        return refused(backendDown(deps.extensionBackend));
    }
    // Read through the daemon's own settings, so organisation pins apply: a key set to deny after the yes still refuses.
    const { actionRules } = await deps.sandboxSettings.get();
    const action: ApprovedAction = {
        id: item.id,
        digest: item.performer.digest,
        summary: item.summary,
        details: item.details ?? "",
        approver: yes.approver,
        approvedAt: yes.approvedAt,
        actionRules: { ...actionRules },
    };
    try {
        const answered = await fetch(`http://127.0.0.1:${backend.port}/approvals/${encodeURIComponent(performer.id)}`, {
            method: "POST",
            headers: { "content-type": "application/json", [BACKEND_HOST_HEADER]: backend.hostToken },
            body: approvalRequestBody(action),
            signal,
        });
        return await outcomeOf(answered);
    } catch (error) {
        // Refused only when the host was not listening, so not a byte left; past that, the action may be under way.
        return errnoCode(error instanceof Error ? error.cause : undefined) === "ECONNREFUSED"
            ? refused(`the extension's backend was not listening (${errorMessage(error)})`)
            : uncertain(`the extension's backend did not answer (${errorMessage(error)})`);
    }
};
