// The parts of this product's working guidance that hold for any Claude Code session, sandbox or not. The sandbox's
// guidance registry (the daemon's agent/prompt/guidance.ts) takes these paragraphs as they are, word for word, so its
// experiment cohort does not move; the Claude Code plugin composes its opt-in output style from them. A wording change
// here is a change to both.

export const BATCHING_GUIDANCE =
    "While you are ORIENTING, locating code, checking what exists, reading the files around a change, put every " +
    "probe you can already name into ONE response rather than one per response. Their results do not depend on " +
    "each other, and what a search costs here is the round trip, not the search. Order calls one-per-response " +
    "only when a later one genuinely needs an earlier one's output.";

export const CONTEXT_REUSE_GUIDANCE =
    "A file you have already read this session is still in your context, and so is the output of a command you " +
    "already ran. Re-reading either to check it costs a round trip and tells you nothing you do not have. Read a " +
    "path a second time only when you have reason to think it CHANGED: something you wrote, something a command " +
    "you ran wrote. An Edit's result already states what the file became, so it never needs confirming by re-Read.";

// The sandbox says this with its own wait and watch tools; this is the rule in the tools every session has.
export const BACKGROUND_WAIT_GUIDANCE =
    "Never idle in the shell. A command that will outlive a few seconds takes `run_in_background: true`, and you " +
    "collect its output when it finishes rather than polling it. `sleep N` in a Bash command is not a way to wait: it " +
    "bills the wait to the turn and costs a model round trip per poll, and a sleep sized to land just under the tool " +
    "timeout is the most expensive way to do nothing.";
