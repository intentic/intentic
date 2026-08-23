/* HOW HARD A TURN LOOKS BEFORE ANYTHING HAS BEEN SPENT ON IT, the judge behind automatic tier selection.
 *
 * The job is narrow on purpose: decide whether this turn could have run on the cheap rung of the provider the
 * user is already on. Nothing here picks a model, nothing here reads a catalog, and nothing here calls
 * anything. It is a pure function over the turn's own words and shape, so the daemon and the composer can both
 * ask it and get the same answer, which is the same reason quick-model.ts lives in the contract rather than in
 * either of them.
 *
 * IT CAN ONLY EVER ROUTE DOWN. The standard tier is not a setting: it is whatever the user already picked. So
 * the question this file answers is never "which of two models" but "may we substitute something cheaper for
 * the one they chose", and every ambiguous answer is NO. That asymmetry is the whole safety argument, and it is
 * why there is no fail-up branch to get wrong: failing up means doing exactly what was asked.
 *
 * WHY RULES AND NOT A MODEL. Two findings decide this. Across the routing literature nothing sophisticated
 * beats a simple predictor over decent features (a tuned kNN and a linear head tie, and both beat graph and
 * attention routers costing 13-14x more), and a router that spends an LLM call to save an LLM call has spent
 * the saving. So the layer is deliberately narrow, transparent, and free. See docs/model-routing-design.md.
 *
 * WHY EVERY RULE IS NAMED. A verdict carries the rules that fired, not just a number. That is what lets a
 * screen say WHY a turn was downgraded, what makes a bad call reportable rather than mysterious, and what makes
 * the shadow ledger analysable later: a score alone tells you a threshold was crossed, the rules tell you which
 * feature is doing the work. The interpretable-router literature (Routesplain, COLM 2026) reaches the same
 * conclusion from the accuracy side, but the operational one is enough on its own. */

// The named features. A verdict lists these, the shadow ledger stores them, and a screen renders them, so they
// are a vocabulary rather than debug strings: renaming one is a breaking change to what past rows mean.
export type ComplexityRule =
    // Gates. Any one of these ends the question: the turn is standard and no score is computed.
    | "images"
    | "plan-mode"
    | "unattended"
    // Escalating rules. Any one forces standard. Order between them cannot matter, which is the point.
    | "code-block"
    | "stack-trace"
    | "hard-words"
    | "multi-step"
    | "cross-cutting"
    | "long-prompt"
    | "many-attachments"
    // Graded features. These only move the score.
    | "medium-prompt"
    | "attachment"
    | "editor-context"
    | "paths"
    | "many-verbs"
    | "after-hard-turn"
    | "short-prompt"
    | "easy-words"
    | "bare-question"
    | "no-workspace-reference";

export type ComplexityTier = "fast" | "standard";

/* Everything the judge is allowed to know. Deliberately primitive: counts, flags and the prompt itself, no
 * objects owned by either side, so the daemon's turn and the composer's draft can each build one without
 * agreeing about anything else. The same "compress route state into cheap primitive fields" shape the serving
 * literature converges on. */
export interface ComplexityInput {
    readonly prompt: string;
    // Uploaded files plus @-mentioned workspace paths; the daemon resolves both into one list, so one count.
    readonly attachments: number;
    // Any attachment the model will read as an image. A cheap rung reading a screenshot is the worst cell in
    // the matrix: it is the tier most likely to misread it and the turn least likely to notice.
    readonly hasImages: boolean;
    // The opt-in editor chip: the user pointed at a file and a selection, so the turn is about real code.
    readonly editorContext: boolean;
    // A surface started this, not a person at a composer (AgentTurn.unattended).
    readonly unattended: boolean;
    // The turn opens in plan mode: it is being asked to think before it acts, which is the request itself.
    readonly planMode: boolean;
    /* THE TURN BEFORE THIS ONE, IN THIS CONVERSATION, WAS JUDGED STANDARD.
     *
     * The most important field, and the one a prompt-only judge cannot derive. "now do the same for the other
     * file" is nine easy words carrying the whole weight of the task before it, and a judge reading only the
     * words will downgrade it every time. The routing work closest to this product (SWE-Router, over SWE-bench)
     * states the general form: prompt-only routers inherit an information-theoretic error floor because the
     * difficulty lives in the trajectory rather than in the request. Their answer is a 7B value model reading
     * partial trajectories; ours is one boolean, which costs nothing and catches the case that actually bites.
     *
     * IT RAISES THE BAR, IT DOES NOT LOCK THE DOOR, and that is a deliberate softening of the rule this was
     * designed as. A hard "once standard, always standard" lock reads well and is nearly useless: opening
     * messages are substantive, so almost every conversation would take standard on turn one and never be
     * eligible again, which is a mechanism that saves nothing while carrying all of the risk. As a weight it
     * still stops the deceptive follow-up (which scores near the base and cannot afford the penalty) while a
     * genuinely trivial aside inside a hard conversation still gets through, and that aside is a real and
     * common turn.
     *
     * The JUDGEMENT, not what ran: a turn judged fast that ran standard anyway (nothing cheaper in the catalog,
     * or the feature switched off) says nothing about the difficulty of the work, and reading it as escalation
     * would make the sandbox's configuration leak into its opinion about a sentence. */
    readonly afterHardTurn: boolean;
    /* HOW EAGER THE OWNER ASKED THIS TO BE (settings.autoTierEagerness), the one preference the judge takes.
     * Absent ⇒ `balanced`, which is the stop every verdict recorded before the knob existed was judged
     * against, so an absent value and an old row mean the same thing. See FAST_CEILINGS. */
    readonly eagerness?: TierEagerness;
}

export interface ComplexityVerdict {
    readonly tier: ComplexityTier;
    // 0..1, rounded to three places so ledger rows compare exactly and do not carry float noise. 1 whenever a
    // gate or an escalating rule fired: those do not produce a degree of difficulty, they produce an answer.
    readonly score: number;
    // Every rule that fired, in declaration order. Empty is legal and means "nothing distinctive": the score is
    // the base, which sits above the fast ceiling, so an unremarkable turn stays on the user's own pick.
    readonly rules: readonly ComplexityRule[];
    /* The cutoff this score was judged against, carried out so the caller can record it beside the score.
     * A score is only half a verdict once the ceiling is a setting: 0.35 was standard yesterday and is fast
     * today, and a refit reading a column of bare scores could not tell those rows apart. */
    readonly ceiling: number;
}

/* WHERE AN UNREMARKABLE TURN STARTS, and it starts ABOVE the fast ceiling on purpose: a prompt that matches no
 * rule at all is medium, not simple. That is the reference keyword-router convention and it is the conservative
 * reading of silence, which is the only safe one when the downside of a wrong downgrade is a retry, an
 * escalation, and a user who stops trusting the feature. */
const BASE_SCORE = 0.5;

/* HOW EAGER THE JUDGE IS, the one knob this feature exposes, and deliberately the only one.
 *
 * The routing literature's own answer to "how do you tune a router in public" is a single aggressiveness
 * threshold (RouteLLM ships it in the model name, `router-mf-0.3` against `router-mf-0.7`); everything else it
 * learns stays inside. Same here: the weights below are a hypothesis with a ledger under them and are nobody's
 * business, while "should this err toward my model or toward the cheap one" is a preference only the owner can
 * hold, and the shadow numbers are useless without a way to act on what they say.
 *
 * THREE NAMED STOPS, not a slider, because the page has no slider idiom and, more to the point, a continuous
 * control here invites fiddling with a number whose meaning nobody can feel. Each stop is a sentence about
 * which turns move:
 *   cautious — every easing signal at once and nothing pulling the other way: a short bare question, in easy
 *              words, naming no file. "what is a closure?" and very little else. The zero is not a disabled
 *              state, it is the floor the score clamps to, so it means exactly "leave no room for doubt".
 *   balanced — the shipped default, and what every stored verdict before this knob existed was judged against.
 *              Easy words carry a turn on their own; naming a file still holds it back.
 *   eager    — an easy-worded question about real code goes too ("explain what this file does").
 *
 * NONE OF THEM CAN REACH THE ABSENCE FEATURES, at any setting, because that property is enforced structurally
 * now rather than by the weights happening to sum above the ceiling (see `easing` below). That is what makes an
 * eager stop safe to offer at all: raising a bare number would, at 0.3, have started downgrading every short
 * vague request in the product, which is the single worst population to be wrong about. */
export const FAST_CEILINGS = { cautious: 0, balanced: 0.25, eager: 0.4 } as const;
export type TierEagerness = keyof typeof FAST_CEILINGS;

// The stop a turn is judged against when nobody has chosen one, and the one every verdict recorded before the
// knob existed was judged against. Exported because a reader of a stored score needs the ceiling behind it, and
// a row written before ceilings were recorded was written against exactly this.
export const FAST_CEILING = FAST_CEILINGS.balanced;

// Characters, not tokens: nothing here can tokenize, and for a threshold the constant cancels. ~600 chars is
// where a request stops being a sentence and starts being a brief; ~2400 is where it is carrying pasted
// material it has not fenced.
const MEDIUM_PROMPT_CHARS = 600;
const LONG_PROMPT_CHARS = 2400;
const SHORT_PROMPT_CHARS = 140;
// Three files in is a job about a shape rather than about a file, whatever the words say.
const MANY_ATTACHMENTS = 3;
// Three or more distinct imperatives is a list of jobs wearing the grammar of one.
const MANY_VERBS = 3;

/* THE WORD LISTS. Kept short and boring, because a hand-written lexicon is the part of a router that rots: it
 * is inflexible by construction and every addition is a guess about traffic nobody has measured yet. It exists
 * to catch the unambiguous ends of the distribution and to hand everything else to the score.
 *
 * Both lists are matched on word boundaries and case-insensitively. `easy` only ever lowers a score; `hard`
 * forces standard outright, which is the asymmetry the rest of this file is built on. */
const EASY_WORDS =
    /\b(?:what(?:'s| is| are)|explain|describe|summari[sz]e|list|show me|where(?:'s| is| are)|rename|typo|reword|reformat|format this|tidy|define|translate|spell|abbreviat)/i;

const HARD_WORDS =
    /\b(?:refactor|redesign|architect|architecture|migrat|root cause|debug|investigat|diagnos|optimi[sz]|race condition|deadlock|memory leak|regression|security|threat model|benchmark|profil|audit|design a|plan (?:a|the|out)|why (?:does|is|are|did|would|can't|cannot))/i;

// "Do this, and also that." The strongest cheap signal of a job that is several jobs, and the one an easy-
// sounding sentence hides behind most often.
const MULTI_STEP = /\b(?:and then|after that|once (?:that|you)|followed by|as well as|then also)\b/i;

// A job whose subject is the shape of the codebase rather than a place in it. A cheap rung asked to be
// consistent across twenty files is being asked the one thing it is worst at.
const CROSS_CUTTING =
    /\b(?:across (?:the|all|every)|every(?: single)? (?:file|module|package|component|usage|call ?site)|all (?:the|of the) (?:files|usages|call ?sites|places)|everywhere|throughout the|codebase-wide|repo-wide)\b/i;

// Fenced code, a unified diff, or an inline patch. Pasted code is not proof of difficulty by itself, but it is
// proof the turn is about real code rather than about a word, and the cheap rung's failures there are silent.
const CODE_BLOCK = /```|^diff --git |^@@ .* @@|^[+-]{3} [ab]\//m;

// A thrown error the user has pasted in. Debugging from a trace is the canonical case where the expensive tier
// earns its price, and it is trivially detectable.
const STACK_TRACE =
    /(?:^|\n)\s*(?:at [\w$.<>]+ \(|Traceback \(most recent call last\)|Caused by:|panic:|thread '.*' panicked|Unhandled|[A-Z]\w*(?:Error|Exception): )/;

// A workspace path or an @-mention in the prose. Distinguishes "explain closures" from "explain what this file
// does" without claiming either is hard.
const PATH_LIKE =
    /(?:^|\s)(?:@[\w./-]+|[\w-]+\/[\w./-]+\.[a-z]{1,5}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|vue|py|go|rs|java|rb|css|scss|json|ya?ml|md|sql|sh)\b)/i;

// One sentence, ending in a question mark, with no second clause. Knowledge, not work.
const BARE_QUESTION = /^[^.!?]{0,200}\?\s*$/;

// Imperatives that start a request. Counted, not matched: one is a task, three is a list.
const VERBS =
    /\b(?:add|remove|delete|fix|write|create|make|update|change|move|rename|split|merge|extract|inline|wire|hook|test|check|run|build|deploy|document|implement|replace|convert|handle|support|expose|log|render|validate|parse|sort|filter|cache)\b/gi;

// Bullets and numbered steps, which is a checklist however casually it is written.
const LIST_LINES = /^\s*(?:[-*+]\s|\d+[.)]\s)/gm;

// Every rule that ends the question on its own, paired with the test that fires it. Split from the graded
// features below because the two are read differently: these are answers, those are evidence.
const forcing = (input: ComplexityInput, text: string): ComplexityRule[] => {
    const rules: ComplexityRule[] = [];
    // Gates first, cheapest and least arguable. They are about the turn's SITUATION rather than its words.
    if (input.hasImages) {
        rules.push("images");
    }
    if (input.planMode) {
        rules.push("plan-mode");
    }
    /* An unattended run is billed whole and nobody is watching it fail. The settings this repo already ships
     * make the same call in the other direction: agentRunModels resolves to NOTHING when empty precisely
     * because "nothing here can judge whether a job is worth the frontier tier". This file does judge, but not
     * for the runs where a wrong guess costs a whole session with a worktree in it. */
    if (input.unattended) {
        rules.push("unattended");
    }
    // Then the words. Every one of these is a claim that the turn is about real code doing something real.
    if (CODE_BLOCK.test(text)) {
        rules.push("code-block");
    }
    if (STACK_TRACE.test(text)) {
        rules.push("stack-trace");
    }
    if (HARD_WORDS.test(text)) {
        rules.push("hard-words");
    }
    if (MULTI_STEP.test(text) || (text.match(LIST_LINES)?.length ?? 0) >= 2) {
        rules.push("multi-step");
    }
    if (CROSS_CUTTING.test(text)) {
        rules.push("cross-cutting");
    }
    if (text.length > LONG_PROMPT_CHARS) {
        rules.push("long-prompt");
    }
    if (input.attachments >= MANY_ATTACHMENTS) {
        rules.push("many-attachments");
    }
    return rules;
};

/* The graded half: what nudges an otherwise ordinary request either way. Weights are a starting shape fitted to
 * nothing, which is exactly why the mechanism ships in shadow first — see docs/model-routing-design.md §4. They
 * are not a claim, they are a hypothesis with a ledger under it.
 *
 * ONE PROPERTY IS NOT A HYPOTHESIS AND MUST SURVIVE ANY REFIT, and it is a RULE here rather than an accident of
 * arithmetic: absence of complexity is not evidence of simplicity. "fix the bug" is four words naming no file
 * and is not a cheap turn, so a downgrade always requires something POSITIVE to have been said — an easy word,
 * or a bare question. Those two are marked `easing`, and `judgeComplexity` refuses a fast verdict without one
 * whatever the score says.
 *
 * It used to hold only because the two ABSENCE features (`short-prompt`, `no-workspace-reference`) summed to
 * 0.3 against a ceiling of 0.25, which is a coincidence of two numbers rather than a property, and the moment
 * the ceiling became a setting it was one click from being false. Weighted the obvious way, the judge
 * downgraded every short vague request in the product, which is the single worst population to be wrong
 * about. */
interface GradedFeature {
    readonly rule: ComplexityRule;
    readonly weight: number;
    readonly of: (input: ComplexityInput, text: string) => boolean;
    // A POSITIVE reason to think this is easy, as opposed to the mere absence of reasons to think it is hard.
    // At least one has to fire before any turn is called fast; see the note above.
    readonly easing?: true;
}

const GRADED: readonly GradedFeature[] = [
    { rule: "medium-prompt", weight: +0.2, of: (_input, text) => text.length > MEDIUM_PROMPT_CHARS },
    { rule: "attachment", weight: +0.15, of: (input) => input.attachments > 0 },
    { rule: "editor-context", weight: +0.1, of: (input) => input.editorContext },
    // Enough on its own to hold an easy-worded question at standard on the middle stop: "explain what this file
    // does" is a question about real code in this repo, and the cheap rung's failures on real code are the
    // silent kind. The `eager` stop is precisely the choice to let that one through.
    { rule: "paths", weight: +0.15, of: (_input, text) => PATH_LIKE.test(text) },
    {
        rule: "many-verbs",
        weight: +0.15,
        of: (_input, text) => new Set((text.match(VERBS) ?? []).map((verb) => verb.toLowerCase())).size >= MANY_VERBS,
    },
    // The heaviest single weight, because it is the only feature that can see past the words. See
    // ComplexityInput.afterHardTurn for why it is a weight rather than the gate it was designed as. Heavy enough
    // that even the eager stop cannot route a follow-up to hard work on easy words alone.
    { rule: "after-hard-turn", weight: +0.25, of: (input) => input.afterHardTurn },
    /* The easing half, in the order it has always been declared, because that order is the order a verdict
     * lists its rules in and the ledger has rows written against it. `easing` marks the two POSITIVE ones, one
     * of which every fast verdict must carry; the other two are the absence features, deliberately light and,
     * by the rule above, never enough by themselves. */
    { rule: "short-prompt", weight: -0.1, of: (_input, text) => text.length <= SHORT_PROMPT_CHARS },
    { rule: "easy-words", weight: -0.25, easing: true, of: (_input, text) => EASY_WORDS.test(text) },
    { rule: "bare-question", weight: -0.15, easing: true, of: (_input, text) => BARE_QUESTION.test(text) },
    {
        rule: "no-workspace-reference",
        weight: -0.1,
        of: (input, text) => input.attachments === 0 && !input.editorContext && !PATH_LIKE.test(text),
    },
];

// Three places, so a stored score is a value rather than a float artefact and two rows written by the same
// rules compare equal.
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/* THE VERDICT. Gates and escalating rules first, and if any fired the answer is standard at score 1 — no
 * partial credit, no weight to tune, and no way for rule ORDER to change the outcome. That monotone-escalation
 * property is worth more than the accuracy it costs: it means adding a rule tomorrow can only ever move turns
 * up a tier, never silently move a different set of turns down.
 *
 * Only what survives all of that gets scored, which keeps the graded layer doing the one job it is good at:
 * separating "explain this" from "wire this up" among requests that look alike.
 *
 * TWO CONDITIONS FOR FAST, not one, and the second is the one that does not move: the score has to clear the
 * owner's chosen ceiling AND something POSITIVE has to have been said (a `easing` feature). The ceiling is a
 * preference and belongs to whoever pays the bill; "we downgraded it because you didn't say much" is not a
 * preference, it is a bug, and it stays impossible at every stop of the knob. */
export const judgeComplexity = (input: ComplexityInput): ComplexityVerdict => {
    const ceiling = FAST_CEILINGS[input.eagerness ?? "balanced"];
    const text = input.prompt.trim();
    const forced = forcing(input, text);
    if (forced.length > 0) {
        return { tier: "standard", score: 1, rules: forced, ceiling };
    }
    const hits = GRADED.filter((feature) => feature.of(input, text));
    const score = Math.min(1, Math.max(0, BASE_SCORE + hits.reduce((total, feature) => total + feature.weight, 0)));
    const eased = hits.some((feature) => feature.easing === true);
    return {
        tier: eased && score <= ceiling ? "fast" : "standard",
        score: round3(score),
        rules: hits.map((feature) => feature.rule),
        ceiling,
    };
};
