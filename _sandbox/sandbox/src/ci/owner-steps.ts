import { isCiFixConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { CI_OWNER_STEP_MARK, type CiOwnerStep } from "@intentic/sandbox-contract/schemas/ci";
import type { Services } from "../composition.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";

/* A STEP OUTSIDE THE REPOSITORY, the one ending of a CI fix that no commit is. A release publish refused for a field
   missing in a store's dashboard (v1.353.0, v1.401.0, v1.413.0) is fixed by a person in that dashboard and a re-run;
   asked to "fix it and commit", three agents each committed a docs line, the board read the landed docs as the fix,
   and the step itself sat in a transcript nobody was pointed at. The fix prompt (ci-fix.ts) asks an agent to open its
   final message with `Owner step: …` instead; the sandbox keeps that line per agent, and the board shows it on the run. */

// Long enough for "where, what to paste, then re-run"; a paragraph past it is the transcript's.
const STEP_MAX = 600;

// Leading markdown an agent wraps a line in: emphasis, a list bullet, a quote.
const DECORATION = /^[\s>*_#-]*/;

/** The step a closing message names, or undefined when it names none: the line opening with the mark (any case,
 *  markdown around it allowed) and the lines after it up to the paragraph's end. */
export const ownerStepOf = (closing: string): string | undefined => {
    const lines = closing.split("\n");
    const mark = CI_OWNER_STEP_MARK.toLowerCase();
    const index = lines.findIndex((line) => line.replace(DECORATION, "").toLowerCase().startsWith(mark));
    if (index === -1) {
        return undefined;
    }
    const first = (lines[index] ?? "").replace(DECORATION, "").slice(CI_OWNER_STEP_MARK.length);
    const rest = lines.slice(index + 1);
    const end = rest.findIndex((line) => line.trim() === "");
    const paragraph = [first, ...(end === -1 ? rest : rest.slice(0, end))]
        .map((line) => line.replace(/\*\*/g, "").trim())
        .filter((line) => line !== "")
        .join(" ");
    if (paragraph === "") {
        return undefined;
    }
    return paragraph.length <= STEP_MAX ? paragraph : `${paragraph.slice(0, STEP_MAX - 1)}…`;
};

/** A CI fix agent's turn ended: keep the step it ended on, or let go of an earlier one when this turn names none. A turn
 *  stopped mid-way, or one the sandbox runs again by itself, has not said its last word yet. */
export const ownerStepSettled = async (
    services: Pick<Services, "ciStore">,
    settled: { readonly conversationId: string; readonly closing: string; readonly stopped?: true; readonly rerun?: unknown },
): Promise<void> => {
    if (settled.rerun !== undefined || settled.stopped === true || !isCiFixConversationId(settled.conversationId)) {
        return;
    }
    const step = ownerStepOf(settled.closing);
    const changed = await services.ciStore.ownerStep(settled.conversationId, step === undefined ? undefined : { step, at: Date.now() });
    if (changed) {
        publishRuntimeChange("ci");
    }
};

/** Every step kept, as GET /ci/runs serves it. */
export const ownerSteps = async (services: Pick<Services, "ciStore">): Promise<CiOwnerStep[]> =>
    Object.entries(await services.ciStore.ownerSteps()).map(([conversationId, kept]) => ({ conversationId, ...kept }));
