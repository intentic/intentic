import type { LandedMessageDraft } from "@intentic/sandbox-contract/schemas/agents";
import { modelLabelFor } from "../providers/providerCatalog";

// Where a landing's commit message stands while a model writes it (the roster's `landedMessageDraft`), read the same way
// by every surface that waits on it: the Changes panel's box and chips, the maker's save panel, and a chat's own strip.

// True while a draft has no outcome yet — the state every wait-related surface keys on.
export const draftRunning = (draft: LandedMessageDraft | undefined): boolean => draft !== undefined && draft.outcome === undefined;

// The model the draft is waiting on right now: its newest step, while that step is still out. Undefined while the diff is
// still being read, and between a refusal and the next ask.
export const askingModel = (draft: LandedMessageDraft | undefined): string | undefined => {
    const step = draft?.steps.at(-1);
    return step?.status === `asking` ? modelLabelFor(step.provider, step.model) : undefined;
};
