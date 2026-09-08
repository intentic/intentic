// Judges whether a turn could run on the cheap rung of the provider the user is already on: a pure function over the
// turn's shape, no model or catalog access. Never fails up: every ambiguous case resolves to standard, since
// substituting a pricier model would just be honoring the original request.

// A verdict lists these, the shadow ledger stores them, a screen renders them: renaming one is a breaking change.
export type ComplexityRule =
    // Gates: any one ends the question, standard with no score computed.
    | "images"
    | "plan-mode"
    | "unattended"
    // Escalating rules: any one forces standard; order between them cannot matter.
    | "code-block"
    | "stack-trace"
    | "hard-words"
    | "multi-step"
    | "cross-cutting"
    | "long-prompt"
    | "many-attachments"
    // Graded features: these only move the score.
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

// Everything the judge may know: primitive counts, flags and the prompt itself, no shared objects, so the daemon's turn
// and the composer's draft can each build one independently.
export interface ComplexityInput {
    readonly prompt: string;
    // Uploaded files plus @-mentioned workspace paths, resolved by the daemon into one count.
    readonly attachments: number;
    // Any attachment the model will read as an image; a cheap rung misreading one is the worst cell in the matrix.
    readonly hasImages: boolean;
    // The opt-in editor chip: the user pointed at a file and a selection, so the turn is about real code.
    readonly editorContext: boolean;
    // A surface started this, not a person at a composer (AgentTurn.unattended).
    readonly unattended: boolean;
    // The turn opens in plan mode: it is being asked to think before it acts.
    readonly planMode: boolean;
    // Whether the prior turn's judgement (not what it ran) was standard; a weight that raises the bar, not a lock.
    readonly afterHardTurn: boolean;
    // settings.autoTierEagerness; absent means balanced, what every pre-knob verdict was judged against.
    readonly eagerness?: TierEagerness;
}

export interface ComplexityVerdict {
    readonly tier: ComplexityTier;
    // 0..1, rounded to three places so ledger rows compare exactly; 1 whenever a gate or escalating rule fired.
    readonly score: number;
    // Every rule that fired, in declaration order; empty means the base score, above the fast ceiling.
    readonly rules: readonly ComplexityRule[];
    // The ceiling this score was judged against, carried out since the ceiling is itself a setting that can change.
    readonly ceiling: number;
}

// Above the fast ceiling on purpose: a prompt matching no rule at all is medium, not simple.
const BASE_SCORE = 0.5;

// How eager the judge is (settings.autoTierEagerness), the one knob this feature exposes:
// - cautious: floor of 0, downgrades only the clearest easy asks
// - balanced: the shipped default; every verdict before this knob existed was judged against it
// - eager: also lets an easy-worded question about real code through
export const FAST_CEILINGS = { cautious: 0, balanced: 0.25, eager: 0.4 } as const;
export type TierEagerness = keyof typeof FAST_CEILINGS;

// The stop used when nobody chose one: balanced, what every pre-knob verdict was judged against.
export const FAST_CEILING = FAST_CEILINGS.balanced;

// Characters, not tokens: thresholds mark a sentence turning into a brief, or carrying unfenced paste.
const MEDIUM_PROMPT_CHARS = 600;
const LONG_PROMPT_CHARS = 2400;
const SHORT_PROMPT_CHARS = 140;
// Three files in is a job about a shape rather than about a file, whatever the words say.
const MANY_ATTACHMENTS = 3;
// Three or more distinct imperatives is a list of jobs wearing the grammar of one.
const MANY_VERBS = 3;

// Short, boring word lists, case-insensitive on word boundaries; easy only lowers score, hard forces standard.
const EASY_WORDS =
    /\b(?:what(?:'s| is| are)|explain|describe|summari[sz]e|list|show me|where(?:'s| is| are)|rename|typo|reword|reformat|format this|tidy|define|translate|spell|abbreviat)/i;

const HARD_WORDS =
    /\b(?:refactor|redesign|architect|architecture|migrat|root cause|debug|investigat|diagnos|optimi[sz]|race condition|deadlock|memory leak|regression|security|threat model|benchmark|profil|audit|design a|plan (?:a|the|out)|why (?:does|is|are|did|would|can't|cannot))/i;

// "Do this, and also that": the strongest cheap signal of a job that is several jobs.
const MULTI_STEP = /\b(?:and then|after that|once (?:that|you)|followed by|as well as|then also)\b/i;

// A job whose subject is the shape of the codebase, not a place in it; the cheap rung is worst at exactly this.
const CROSS_CUTTING =
    /\b(?:across (?:the|all|every)|every(?: single)? (?:file|module|package|component|usage|call ?site)|all (?:the|of the) (?:files|usages|call ?sites|places)|everywhere|throughout the|codebase-wide|repo-wide)\b/i;

// Fenced code, a diff, or an inline patch: proof the turn is real code, where the cheap rung fails silently.
const CODE_BLOCK = /```|^diff --git |^@@ .* @@|^[+-]{3} [ab]\//m;

// A thrown error the user pasted in: the canonical case where the expensive tier earns its price.
const STACK_TRACE =
    /(?:^|\n)\s*(?:at [\w$.<>]+ \(|Traceback \(most recent call last\)|Caused by:|panic:|thread '.*' panicked|Unhandled|[A-Z]\w*(?:Error|Exception): )/;

// A workspace path or @-mention, distinguishing "explain closures" from "explain what this file does".
const PATH_LIKE =
    /(?:^|\s)(?:@[\w./-]+|[\w-]+\/[\w./-]+\.[a-z]{1,5}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|vue|py|go|rs|java|rb|css|scss|json|ya?ml|md|sql|sh)\b)/i;

// One sentence, ending in a question mark, with no second clause: knowledge, not work.
const BARE_QUESTION = /^[^.!?]{0,200}\?\s*$/;

// Imperatives that start a request, counted rather than matched: one is a task, three is a list.
const VERBS =
    /\b(?:add|remove|delete|fix|write|create|make|update|change|move|rename|split|merge|extract|inline|wire|hook|test|check|run|build|deploy|document|implement|replace|convert|handle|support|expose|log|render|validate|parse|sort|filter|cache)\b/gi;

// Bullets and numbered steps, a checklist however casually it is written.
const LIST_LINES = /^\s*(?:[-*+]\s|\d+[.)]\s)/gm;

// Every rule that ends the question on its own; split from the graded features below because these are answers, not
// evidence.
const forcing = (input: ComplexityInput, text: string): ComplexityRule[] => {
    const rules: ComplexityRule[] = [];
    // Gates first, cheapest and least arguable: about the turn's situation rather than its words.
    if (input.hasImages) {
        rules.push("images");
    }
    if (input.planMode) {
        rules.push("plan-mode");
    }
    // Unattended turns are billed whole with nobody watching a bad guess.
    if (input.unattended) {
        rules.push("unattended");
    }
    // Then the words: each of these claims the turn is about real code doing something real.
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

// Weights are a fitted hypothesis with a ledger under them, not a claim (ships in shadow first). A fast verdict always
// requires a positive `easing` feature to have fired: absence of complexity is not evidence of simplicity.
interface GradedFeature {
    readonly rule: ComplexityRule;
    readonly weight: number;
    readonly of: (input: ComplexityInput, text: string) => boolean;
    // A positive reason to think this is easy, not merely an absence of reasons to think it is hard.
    readonly easing?: true;
}

const GRADED: readonly GradedFeature[] = [
    { rule: "medium-prompt", weight: +0.2, of: (_input, text) => text.length > MEDIUM_PROMPT_CHARS },
    { rule: "attachment", weight: +0.15, of: (input) => input.attachments > 0 },
    { rule: "editor-context", weight: +0.1, of: (input) => input.editorContext },
    // Naming a file holds an easy-worded question at standard on balanced; eager is the choice to let it through.
    { rule: "paths", weight: +0.15, of: (_input, text) => PATH_LIKE.test(text) },
    {
        rule: "many-verbs",
        weight: +0.15,
        of: (_input, text) => new Set((text.match(VERBS) ?? []).map((verb) => verb.toLowerCase())).size >= MANY_VERBS,
    },
    // The heaviest weight: the only feature seeing past the words, heavy enough eager cannot downgrade past it.
    { rule: "after-hard-turn", weight: +0.25, of: (input) => input.afterHardTurn },
    // Declared in ledger order. `easing` marks the two positive signals; the rest are light absence features.
    { rule: "short-prompt", weight: -0.1, of: (_input, text) => text.length <= SHORT_PROMPT_CHARS },
    { rule: "easy-words", weight: -0.25, easing: true, of: (_input, text) => EASY_WORDS.test(text) },
    { rule: "bare-question", weight: -0.15, easing: true, of: (_input, text) => BARE_QUESTION.test(text) },
    {
        rule: "no-workspace-reference",
        weight: -0.1,
        of: (input, text) => input.attachments === 0 && !input.editorContext && !PATH_LIKE.test(text),
    },
];

// Three places, so a stored score is a value not a float artefact, and same-rule rows compare equal.
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

// Gates and escalators force standard at score 1 (monotone: a new rule only moves turns up a tier). Fast otherwise
// needs both a sub-ceiling score and a positive `easing` signal; silence alone never downgrades.
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
