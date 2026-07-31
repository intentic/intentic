import type { Services } from "../composition.js";
import { askQuickModel } from "./quick-model.js";
import { isFailureSentence } from "./failure-sentences.js";

/* THE NAME A CONVERSATION EARNS AFTER ITS FIRST ANSWER — the late half of the naming rule that starts in the
 * contract's title.ts. The derived title is a guess made before the first frame came back, and it inherits
 * every vice of opening prompts: they narrate context before the ask, and five of them in a row read
 * identically on the fleet board. Once a turn has COMPLETED the situation is different — the two best
 * witnesses to what the conversation is about now exist (the prompt and the answer it got), and nothing is
 * waiting on the result. So one quick-model call reads both and names the job.
 *
 * Runs only while the title is still `derived`, which makes the pass self-limiting three ways over:
 * promoteTitle's ranking makes a landed summary final (a second would be a sideways move), a plan heading or
 * a rename beats it outright, and the gate here keeps the model call itself from being spent on a
 * conversation that already answers to a better name. A turn that fails to produce one — no account
 * connected, an empty reply — changes nothing, and the next turn's finish simply tries again. */

// Enough of each side to name the job without paying for a transcript: opening messages front-load the ask
// and closing replies front-load the outcome, so the head of each carries what the name needs.
const EXCERPT_CAP = 4_000;

const excerpt = (text: string): string => (text.length <= EXCERPT_CAP ? text : `${text.slice(0, EXCERPT_CAP)}\n… (truncated)`);

const titlePrompt = (params: { readonly derived: string | undefined; readonly prompt: string; readonly closing: string }): string =>
    [
        `Name this coding-agent session for a fleet board: 3-8 words naming the work itself, in the imperative mood where it fits — like "Add workspace health contract + daemon route" or "Fix flaky auth tests".`,
        ``,
        ...(params.derived === undefined ? [] : [`Current name, auto-derived from the opening message alone: ${params.derived}`, ``]),
        `Opening user message:`,
        excerpt(params.prompt),
        ``,
        `Agent's closing reply:`,
        excerpt(params.closing),
        ``,
        `Reply with the name only — no quotes, no trailing period, no explanation.`,
    ].join(`\n`);

// Wrappers a model reaches for even when told not to — same instinct as cleanCommitSubject: the name is right
// and only its packaging is wrong, so unwrap rather than refuse.
const FENCE = /^```[\w-]*\n?|\n?```$/g;
const LABEL = /^(?:title|name|session\s*(?:title|name)?)\s*:\s*/i;
const BULLET = /^[-*]\s+/;

export const cleanSessionTitle = (reply: string): string => {
    const first = reply
        .trim()
        .replace(FENCE, ``)
        .split(`\n`)
        .map((line) => line.trim())
        .find((line) => line !== ``);
    if (first === undefined) {
        return ``;
    }
    const bare = first.replace(BULLET, ``).replace(LABEL, ``).replace(/\.+$/, ``).trim();
    // Symmetric surrounding quotes only: an apostrophe or a quoted term inside the name is part of it.
    const unquoted = /^(["'`])(.*)\1$/.exec(bare);
    return (unquoted?.[2] ?? bare).trim();
};

/* Read one finished turn and promote the conversation's still-derived title to the quick model's name for it.
 * Resolves without effect whenever there is nothing to do; throws only what askQuickModel throws (nothing
 * connected, a credential that fails resolution) — the call site treats that as a log line, not a failure. */
export const summarizeAgentTitle = async (
    services: Services,
    conversationId: string,
    turn: { readonly prompt: string; readonly closing: string },
): Promise<void> => {
    const entry = services.agents.entry(conversationId);
    if (entry === undefined) {
        return;
    }
    // A stored title that is itself a provider failure sentence was stolen by an earlier pass whose quick-model
    // call hit the condition — it counts as no name at all, so this pass runs again over it (the registry's
    // ranking forfeits its rank the same way; see promoteTitle) and the entry heals on its next finished turn.
    const poisoned = entry.title !== undefined && isFailureSentence(entry.title);
    if (((entry.titleSource ?? "derived") !== "derived" && !poisoned) || turn.closing.trim() === "") {
        return;
    }
    // A closing that IS the failure sentence says nothing about the work — there is no answer to read yet, and
    // feeding it to the namer invites "You've hit your session limit" back as the name. Next turn retries.
    if (isFailureSentence(turn.closing.trim())) {
        return;
    }
    const { text } = await askQuickModel(
        services,
        titlePrompt({ derived: poisoned ? undefined : entry.title, prompt: turn.prompt, closing: turn.closing }),
        new AbortController().signal,
    );
    const title = cleanSessionTitle(text);
    // The refusal check repeats here because the quick model may run on a DIFFERENT provider than the failed
    // turn — its own limit hit or refused credential arrives as this reply's text, not as a thrown error, on
    // providers whose failures stream as prose rather than reaching one-shot's flag.
    if (title === "" || isFailureSentence(title)) {
        return;
    }
    await services.agents.setTitle(conversationId, title, "summary");
};
