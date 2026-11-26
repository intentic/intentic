import { errorMessage } from "@intentic/base/errors";
import { oneLine } from "@intentic/base/one-line";
import type { AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import { updateBrief } from "@intentic/sandbox-contract/briefs/extension-update-brief";
import type { ExtensionUpdate } from "@intentic/sandbox-contract/schemas/extension-updates";
import type { Services } from "../composition.js";

// The `agent` answer to a new release (extension-updates.ts decides when): an agent reads the difference unprompted and
// the update record links to what it found. Writes through the update ledger's own patch, which the caller hands in.

// The installed extension the review is about.
export interface ReviewTarget {
    readonly identity: string;
    readonly ref: string;
    readonly version: string;
    readonly config: { readonly path?: string | undefined };
}

// Rewrites the update an extension's record holds, the one part of the record a review touches (extension-updates.ts
// binds its patchRecord to the workspace for it). Answering with what it was given leaves the record as it was.
export type PatchUpdate = (identity: string, patch: (update: ExtensionUpdate | undefined) => ExtensionUpdate | undefined) => Promise<void>;

// Agent-prepared rung: runs the update card's diff-read unprompted the moment the check records a new sha.
// An ordinary unattended fleet entry in a shared workspace; the update record links to it. Its id is also its branch
// and folder, so kept short: `upd-`, the name without the built-ins' publisher, cut at 16.
let reviewSeq = 0;
const reviewConversationId = (identity: string): string =>
    `upd-${identity.replace(/^intentic\./u, "").replaceAll(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 16).replace(/-+$/u, "")}-${Date.now().toString(36)}${(reviewSeq++).toString(36)}`;

// How much of a failure the card quotes; the review conversation holds the whole of it.
const REVIEW_FAILURE_MAX = 240;

// Runs the review through the detached run every conversation's turn takes (`turns.run`), so it routes its model by the
// `extension-review` role like the rest, and its transcript is recorded for the card's link to open. Resolves to why the
// agent could not read the update, or undefined once it did.
const readUpdate = async (services: Services, turn: AgentTurn & { conversationId: string }): Promise<string | undefined> => {
    const run = services.turns.run(turn);
    if (run === "busy" || run === "archived") {
        return run === "busy" ? "a turn was already running on its conversation" : "its conversation was archived";
    }
    let failure: string | undefined;
    for await (const event of run.frames()) {
        if (event.kind === "error") {
            failure = event.message;
        }
    }
    return failure;
};

// A review that could not read the update turns the card back to its owner with the reason, and drops the link claiming
// an agent already read it; a person can still start one by hand. The conversation keeps the failure in its own record.
const recordReviewFailure = async (patchRecord: PatchUpdate, target: ReviewTarget, update: ExtensionUpdate, why: string): Promise<void> => {
    const needsReview = `an agent was asked to read this update and could not: ${oneLine(why, REVIEW_FAILURE_MAX)}`;
    await patchRecord(target.identity, (current) => {
        if (current?.ref !== update.ref) {
            return current;
        }
        const { review: _read, ...kept } = current;
        return { ...kept, needsReview };
    });
};

export const prepareAgentReview = (services: Services, target: ReviewTarget, update: ExtensionUpdate, patchRecord: PatchUpdate): void => {
    const conversationId = reviewConversationId(target.identity);
    const prompt = updateBrief({
        label: target.identity,
        url: update.url,
        fromRef: target.ref,
        toRef: update.ref,
        path: update.path ?? target.config.path ?? "",
    });
    const turn: AgentTurn & { conversationId: string } = {
        prompt,
        conversationId,
        unattended: true,
        // Model list this read bills to (model-roles.ts); reviewing another author's diff isn't fixing a pipeline.
        runRole: `extension-review`,
        isolated: true,
        title: `Update review: ${target.identity} ${target.version} → ${update.version ?? update.ref.slice(0, 7)}`.slice(0, 80),
    };
    void (async () => {
        try {
            await patchRecord(target.identity, (current) =>
                current?.ref === update.ref ? { ...current, review: { conversationId, at: new Date().toISOString() } } : current,
            );
            // A review that throws before its first frame fails the same way one that ends in an error frame does.
            const failure = await readUpdate(services, turn).catch(errorMessage);
            if (failure !== undefined) {
                services.logger.warn({ extension: target.identity, conversationId, failure }, "extension update: agent review failed");
                await recordReviewFailure(patchRecord, target, update, failure);
            }
        } catch (error) {
            services.logger.warn({ err: error, extension: target.identity, conversationId }, "extension update: agent review could not be recorded");
        }
    })();
};
