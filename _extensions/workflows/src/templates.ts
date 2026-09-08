import type { IconName } from "@intentic/extension-ui";
import type { Workflow, WorkflowStep } from "@intentic/sandbox-contract";

// Ready-made workflow shapes, pure prefill: picking one opens the designer with a real workflow, and nothing is created
// or run until Save. The first races two models on one request in separate worktrees and merges the diffs; the second
// adds a blind third-model score, and isn't the default since it costs an extra session.

export interface WorkflowTemplate {
    readonly icon: IconName;
    // One-line pitch on the gallery card; must make the workflow's shape recognizable at a glance.
    readonly summary: string;
    readonly workflow: Workflow;
}

// Default step shape; `goal` and `prompt` are optional, since a step declaring neither is handed the person's own
// request verbatim.
const step = (id: string, title: string, over: Partial<WorkflowStep> = {}): WorkflowStep => ({
    id,
    title,
    needs: [],
    handoff: `fresh`,
    // `none`, not `claim`: a claim is a completion gate requiring a verdict file, not a free status note.
    output: { kind: `none` },
    checks: [],
    context: `fresh`,
    ...over,
});

// Both get the raw request directly, no goal/prompt/output declared, so neither has a completion gate or a paraphrased
// brief. Titles stay neutral (not naming the model), since downstream steps see them under `### From "<title>"`.
const attempts = (): WorkflowStep[] => [step(`attempt-a`, `Attempt A`, { agent: `claude` }), step(`attempt-b`, `Attempt B`, { agent: `codex` })];

// Shared merge prompt: start from the stronger branch, fix its faults, fold in the other's strengths.
const SYNTHESIS_PROMPT =
    `Two sessions were given the request above and each built it, on the branches named above. Read both diffs in ` +
    `full: the diffs, not the summaries of them, and judge them against what was asked and against the code they ` +
    `had to live in, not against your own taste in style.\n\n` +
    `Then write the version worth keeping, here in your own worktree. Start from the stronger of the two rather ` +
    `than retyping it: in every repository where it changed files, bring its named branch in with \`git merge --squash\`, ` +
    `then fix what it got wrong and fold in whatever the other one did better. Run whatever this project uses to test ` +
    `itself and leave it passing. What lands must read as one change somebody made on purpose, not as two ` +
    `stitched together, and say, in a sentence each, what you took from where.`;

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
    {
        icon: `clone`,
        summary: `What you type goes to Claude and to GPT at the same moment, each building it on a branch of its own. A third session then reads both diffs, keeps what each got right, and writes the merged version.`,
        workflow: {
            id: `two-models-one-task`,
            name: `Two models, one task`,
            description: `One request, built twice at once by different models in their own worktrees, then read side by side and merged into the version worth keeping.`,
            // Both attempts must start at once; 1 here would silently turn this into a race with a false start.
            maxParallel: 2,
            steps: [
                ...attempts(),
                // One step, no separate scoring pass: reading both diffs is the comparison. Unpinned and fresh, with no
                // stake in either attempt; no declared check, since a hardcoded test command failed outside this repo.
                step(`synthesise`, `Take the best of both`, {
                    needs: [`attempt-a`, `attempt-b`],
                    goal: `One coherent implementation exists that keeps the best of both attempts, and the project's own tests pass.`,
                    prompt: SYNTHESIS_PROMPT,
                }),
            ],
        },
    },
    {
        icon: `list-check`,
        summary: `The same race, graded: a third model scores both diffs without knowing who wrote them, and the merge cannot finish until an independent judge accepts its verification.`,
        workflow: {
            id: `two-models-scored`,
            name: `Two models, scored and merged`,
            description: `One request built twice at once, then scored blind by a third model against the repository, and merged under a completion check that reads the score's requirements back.`,
            maxParallel: 2,
            steps: [
                ...attempts(),
                // Pinned to a third provider so neither attempt's family grades its own work; the declared JSON output
                // is a completion gate, and the extra session is why this card isn't the default.
                step(`evaluate`, `Score both attempts`, {
                    needs: [`attempt-a`, `attempt-b`],
                    agent: `grok`,
                    goal: `Both anonymous attempts have been scored against the request, the repository, and concrete verification evidence.`,
                    prompt:
                        `Independently evaluate Attempt A and Attempt B. Read every repository diff using the exact base and branch commands above. ` +
                        `Do not infer or discuss which provider wrote either attempt; labels and authorship are irrelevant. Inspect the surrounding code ` +
                        `where a diff alone is ambiguous. Score each attempt for correctness, completeness, fit with the existing architecture, verification, ` +
                        `and regression risk. Prefer neither if both miss the request. Do not change files: produce the structured evaluation only.`,
                    output: {
                        kind: `json`,
                        fields: [
                            {
                                name: `preferred`,
                                type: `string`,
                                description: `attempt-a | attempt-b | neither, the strongest starting point after inspecting both diffs`,
                                required: true,
                            },
                            {
                                name: `attempt_a_score`,
                                type: `number`,
                                description: `0 to 100 score for Attempt A against the request and repository evidence`,
                                required: true,
                            },
                            {
                                name: `attempt_b_score`,
                                type: `number`,
                                description: `0 to 100 score for Attempt B against the request and repository evidence`,
                                required: true,
                            },
                            {
                                name: `strengths`,
                                type: `string[]`,
                                description: `specific strengths worth preserving, each prefixed with A or B`,
                                required: true,
                            },
                            {
                                name: `risks`,
                                type: `string[]`,
                                description: `specific defects, omissions, or regression risks, each prefixed with A or B`,
                                required: true,
                            },
                            {
                                name: `synthesis_requirements`,
                                type: `string[]`,
                                description: `concrete requirements the final synthesis must satisfy, including verification still needed`,
                                required: true,
                            },
                        ],
                    },
                }),
                // Same merge, plus the score as evidence (not authority) and a judge that rejects the claim unless
                // verification is named and run. No fixed test command, since it would guess a stranger's build system.
                step(`synthesise`, `Take the best of both`, {
                    needs: [`attempt-a`, `attempt-b`, `evaluate`],
                    agent: `grok`,
                    goal: `One coherent implementation exists that keeps the best of both attempts, and the project's own tests pass.`,
                    prompt:
                        `${SYNTHESIS_PROMPT}\n\n` +
                        `Treat the independent score above as evidence, not authority: verify every recommendation against the code before ` +
                        `acting on it, and satisfy every synthesis requirement it lists.`,
                    output: { kind: `claim` },
                    checks: [
                        {
                            kind: `judge`,
                            rubric:
                                `The report identifies the chosen starting point, what was incorporated from the other attempt, the exact verification ` +
                                `commands and their outcomes, and shows that every synthesis requirement and the original request are satisfied now. ` +
                                `Unrun, failing, or vaguely described verification means CONTINUE.`,
                        },
                    ],
                }),
            ],
        },
    },
    // Started by a CI pipeline, not a person; ships with its gate already declared and pointed at its one step. Its
    // root has a prompt, unlike the other templates' roots, since a pipeline hands context (a sha, a branch) rather
    // than an actual request.
    {
        icon: `shield`,
        summary: `The intelligent step for a CI pipeline. The pipeline POSTs what it knows, commit, branch, preview URL, to this workflow's own webhook, one session exercises the change and judges it, and the pipeline reads back pass, fail or blocked.`,
        workflow: {
            id: `release-gate`,
            name: `Release gate`,
            description: `Called by a pipeline over its webhook: a session inspects the change the pipeline named, judges whether it should ship, and answers with a verdict the pipeline can gate the release on.`,
            maxParallel: 1,
            steps: [
                step(`judge`, `Judge the change`, {
                    goal: `The change the pipeline named has been exercised against the workspace and a defensible verdict recorded.`,
                    prompt:
                        `A pipeline called this gate with everything it knows about a change, the text above: typically a commit, a branch, ` +
                        `sometimes a preview URL. Find that change in this workspace and exercise it the way a careful reviewer would: read the ` +
                        `diff against what it claims to do, build and test where the project says how, open the preview if one is named. Judge ` +
                        `only the change in front of you, not the codebase's general state.\n\n` +
                        `Write "pass" only for work you actually verified; write "fail" when the change is broken or falls short of what it ` +
                        `claims. If you cannot reach the work at all: the commit is not here, the preview does not answer, fail this step ` +
                        `rather than writing a verdict you never formed: the pipeline then reads "blocked", which is the honest answer.`,
                    output: {
                        kind: `json`,
                        fields: [
                            {
                                name: `verdict`,
                                type: `string`,
                                description: `pass | fail, pass only when the change was exercised and found safe to ship`,
                                required: true,
                            },
                            {
                                name: `reason`,
                                type: `string`,
                                description: `one sentence on why, the only line of this the pipeline log will show`,
                                required: true,
                            },
                        ],
                    },
                }),
            ],
            gate: { step: `judge`, field: `verdict`, pass: [`pass`] },
        },
    },
    // Splits research into a plan, three parallel researchers, and a writer, since one session can't both research and
    // write well. The plan's three subtopics are named fields (`subtopic_1..3`), since a step can't be told to take the
    // Nth dynamically. Notes travel as each step's closing message, not files; unpinned throughout.
    {
        icon: `search`,
        summary: `Your question becomes a plan with three angles; three researchers each take one, in parallel, and write sourced notes; one writer reads all three and delivers a report that answers the question, citations inline.`,
        workflow: {
            id: `research-report`,
            name: `Research report`,
            description: `A question decomposed into three subtopics, researched in parallel with every claim sourced, and synthesised into one report with inline citations and an honest account of what could not be found.`,
            maxParallel: 3,
            steps: [
                step(`plan`, `Plan`, {
                    goal: `The request is decomposed into three mutually exclusive subtopics that together cover it, with its constraints stated.`,
                    prompt:
                        `Turn the request above into a research plan. Decide what it is really asking, note any constraint it carries (a time window, a geography, a scope), and split it into THREE subtopics that are mutually exclusive and together exhaustive: distinct facets, angles, entities or regions, never three restatements of the whole. ` +
                        `Give the research a short title in sentence case, 3 to 6 words, letters and numbers only. Write each subtopic as the brief its researcher will work from: the objective in one sentence, three to five key questions, the kinds of source to prefer. Do no research yourself.`,
                    output: {
                        kind: `json`,
                        fields: [
                            {
                                name: `title`,
                                type: `string`,
                                description: `3 to 6 words, sentence case, letters and numbers only: names the report and the notes folder`,
                                required: true,
                            },
                            {
                                name: `constraints`,
                                type: `string`,
                                description: `the bounds every researcher must respect: time window, geography, scope, or "none"`,
                                required: true,
                            },
                            {
                                name: `subtopic_1`,
                                type: `string`,
                                description: `the first researcher's brief: objective, key questions, preferred sources`,
                                required: true,
                            },
                            {
                                name: `subtopic_2`,
                                type: `string`,
                                description: `the second researcher's brief, disjoint from the first`,
                                required: true,
                            },
                            {
                                name: `subtopic_3`,
                                type: `string`,
                                description: `the third researcher's brief, disjoint from the other two`,
                                required: true,
                            },
                        ],
                    },
                }),
                ...[1, 2, 3].map((index) =>
                    step(`research-${index}`, `Research ${index}`, {
                        needs: [`plan`],
                        goal: `Subtopic ${index} of the plan is answered with cited findings, and what could not be found is named.`,
                        prompt:
                            `You are one of three researchers working the plan above in parallel; the others cover the other subtopics, so stay inside yours: take the brief in the plan's field subtopic_${index}, and respect its constraints. ` +
                            `Loop: name the gap, search (short queries under five words work best; \`webq\` fetches a page as clean markdown), fetch the pages worth reading in full rather than trusting a snippet, repeat. Vary phrasing between searches. About ten tool calls is typical and fifteen is the ceiling. ` +
                            `Prefer primary sources; treat predictions and hedged narrative as speculation, not fact; when sources conflict say so rather than picking one silently; for recent topics trust what you fetched over what you remember. ` +
                            `Never invent a statistic, quote or citation. A claim you cannot source goes under Gaps, not under Findings. ` +
                            `Your closing message IS your notes and is handed to the writer verbatim, so make it complete and self-contained, in exactly this shape: a top heading with the subtopic, then for each key question a "### Takeaway" (one or two sentences), "### Cited findings" (one line per fact, each ending with an inline [Source](URL); a contradiction cites both), "### Inferences" (yours, labelled as such) and "### Gaps" (what you could not answer and why). Also save the same text to research_notes/<the plan's title>/subtopic-${index}.md.`,
                    }),
                ),
                step(`write`, `Write the report`, {
                    needs: [`research-1`, `research-2`, `research-3`],
                    goal: `A report that answers the original question exists, every major claim carrying an inline citation from the notes, and the gaps stated.`,
                    prompt:
                        `Read the three researchers' notes above in full and write the report that answers the original request. ` +
                        `Shape: a title of about six words with an active verb; then one paragraph that leads with the answer and carries the significance and essential context, dense enough that a reader could stop there; then three to five sections whose headers are signposts stating the finding ("Migratory geese forage 370 extra hours a year", never "Effects on geese"), in dense narrative prose with the critical figures in bold and citations inline as ([Source](URL)) after the claims a reader would want to verify; a table where it genuinely helps; and a short conclusion that adds implications rather than repeating. ` +
                        `Take positions the evidence supports; state plainly what is uncertain or was not found; steelman the alternative where one exists. Drop any major claim, figure or reference the notes do not source: five well-sourced claims beat twenty with half unsourced. ` +
                        `Write the report to reports/<the plan's title>.md and make the whole report your closing message, so the run shows it and the owner can read it without opening a branch.`,
                    output: { kind: `claim` },
                    checks: [
                        {
                            kind: `judge`,
                            rubric:
                                `The closing message is the full report: it opens with a paragraph that answers the question directly, its section headers state findings rather than topics, and every quantitative claim or specific reference carries an inline ([Source](URL)) citation. ` +
                                `Unsourced figures, headers that merely name a topic, or a message that only summarises the report instead of containing it mean CONTINUE.`,
                        },
                    ],
                }),
            ],
        },
    },
];
