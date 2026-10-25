import { deriveTitle } from "@intentic/sandbox-contract/text/title";
import { oneLine } from "@intentic/base/one-line";
import { isFailureSentence, isSelfIdentityAnswer, isToolCallStandIn } from "../../../engines/failure-sentences.js";
import { isBareConversationTitle } from "../../../seams/conversation-title.js";
import type { BeginTurn } from "../../actor/conversation-decide.js";
import type { AgentTitleSource, PersistedAgent, Social } from "../agents-store.js";

// Automatic title quality, precedence and opening names; fleet mutations stay in agents-registry.ts.

const MAX_TITLE_LENGTH = 80;

// Numeric so promoteTitle's comparison is one `<=`; an entry with no title reads as `derived`, replaceable by anything.
const TITLE_RANK: Record<AgentTitleSource, number> = { derived: 0, model: 1, plan: 2, user: 3 };

export const sanitizeTitle = (prompt: string): string | undefined => oneLine(prompt, MAX_TITLE_LENGTH, { ellipsis: false }) || undefined;

// A home is a person's standing conversation, not the job their first message described. Derive its name wherever an
// entry enters the fleet, including older homes with model or plan titles. A person's explicit rename always stands.
export const withHomeTitle = (entry: PersistedAgent): PersistedAgent => {
    if (entry.identity.home !== true || entry.social.title?.source === "user") {
        return entry;
    }
    const owner = entry.social.owner;
    const who = owner?.name?.trim() || owner?.email;
    const text = oneLine(who === undefined ? "Home" : `Home · ${who}`, MAX_TITLE_LENGTH, { ellipsis: false });
    return { ...entry, social: { ...entry.social, title: { text, source: "derived" } } };
};

// What cannot name a conversation's work: a provider's failure sentence, a tool-call stand-in, a model's answer about
// itself, or a bare label (a project or file name with nothing done to it). Never written by an automatic source, and a
// stored one forfeits its rank (automaticMayWrite); the naming pass reads a stored one as no name at all
// (agent/models/title-namer.ts). A person's own rename is the exception both ways.
export const cannotBeAName = (title: string): boolean =>
    isBareConversationTitle(title) || isFailureSentence(title) || isToolCallStandIn(title) || isSelfIdentityAnswer(title);

// Whether an automatic source may write `clean` over what is stored. A person's rename stands whatever it says, and what
// cannot be a name is never written. Otherwise the new title must strictly outrank the stored one, whose
// rank is forfeit when it cannot be a name, or be the one automatic write that is not a rename: the same words from the
// same source, adding the work word they lacked (a parent's description of its child opens as a `model` name, and the
// naming pass gives it only the board's category).
export const automaticMayWrite = (title: Social["title"], clean: string, source: AgentTitleSource, action: string | undefined): boolean => {
    if (title?.source === "user" || cannotBeAName(clean)) {
        return false;
    }
    const currentRank = title === undefined ? TITLE_RANK.derived : cannotBeAName(title.text) ? -1 : TITLE_RANK[title.source];
    const addsAction = title !== undefined && title.text === clean && title.source === source && title.action === undefined && action !== undefined;
    return TITLE_RANK[source] > currentRank || addsAction;
};

// The title a conversation opens with: the turn's own, else its prompt cut to a line the way the browser would. Either
// is `derived`, which the naming pass replaces, unless the turn says its title is a name an agent chose (a parent's
// description of the child it spawned), which keeps that authority; a head cut from the prompt never does.
export const openingTitle = (turn: BeginTurn): Social["title"] => {
    const named = turn.title === undefined ? undefined : sanitizeTitle(turn.title);
    if (named !== undefined) {
        return { text: named, source: turn.titleSource ?? "derived" };
    }
    const derived = sanitizeTitle(deriveTitle(turn.prompt));
    return derived === undefined ? undefined : { text: derived, source: "derived" };
};
