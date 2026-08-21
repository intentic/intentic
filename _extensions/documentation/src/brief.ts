import type { DocComponent, DocTerm } from "./docModel.js";
import { INDEX_TAIL, REPO_DOC_TAIL, REPO_PROSE_TAIL, packagePageTail, stagingDir, stagingPath } from "./paths.js";

/* THE BRIEFS, what makes a documentation session produce orientation rather than a restated API.
 *
 * The daemon has exactly one per-conversation specialization seam: the turn's PROMPT (the system prompt is a
 * sandbox-wide owner setting). Everything below is task instruction, which is what a prompt is for.
 *
 * There are TWO briefs because there are two jobs, and running them in the wrong order is the single biggest
 * quality failure available here:
 *
 *   MAP , one agent, once per run, BEFORE any package is documented. It decides which packages form a logical
 *          component, what the repo's own vocabulary means, and what to read first. Nothing else can decide
 *          those: they are cross-package judgements, and 42 agents deciding independently produce 42 leaflets
 *          with 42 vocabularies and no map at all.
 *   PACKAGE, one agent per package, fanned out after the map exists, each handed ITS component and the shared
 *          glossary so the set reads as one voice.
 *
 * Five things the briefs have to get right, each of which is a specific failure they exist to prevent:
 *
 * 1. THE AUDIENCE IS AN OUTSIDER, NOT A MAINTAINER. Left unsaid, a coding model writes an API reference,
 *    signatures, options, exported names, which is the one artifact the reader can already get for free from
 *    `iq outline`. What cannot be got for free is what this thing is FOR and why it is shaped this way.
 *
 * 2. THE FACTS COME FROM THE TOOL. `intentic-docs facts` computes the package list, the dependency edges, the
 *    sizes and the revisions. An agent left to state those from reading writes numbers that are plausible and
 *    wrong, and a document whose numbers are wrong is worse than no document.
 *
 * 3. FIGURES ARE FENCES, NOT PROSE ABOUT FIGURES, and a PACKAGE agent draws almost none of them. The vocabulary
 *    is inlined verbatim below, because a model told "you may include diagrams" invents a format and gets a code
 *    block. But the measurable figures are computed and drawn by the app now, so the package brief's job is
 *    mostly to say "do not write those", which is why it carries its own shorter figure block.
 *
 * 4. IT WRITES TO STAGING, NEVER INTO THE REPO. Published documents are committed by the owner's Publish action
 *    after they have read them. An agent that writes a package's README straight into the package has published
 *    without review, which is the one outcome the two-tree design exists to prevent, and the temptation is
 *    sharper now that the destination is an ordinary file beside the code rather than a documentation directory.
 *
 * 5. IT VALIDATES ITS OWN OUTPUT. `intentic-docs validate` is on its PATH; the brief requires a clean run before
 *    it finishes. Schema conformance and dead anchors are the agent's loop, not the reader's surprise. */

// Kept out of both briefs' bodies so the two cannot drift on the one rule that decides how the whole set reads.
const AUDIENCE = [
    `## Who you are writing for`,
    ``,
    `A capable engineer who has never opened this repository and has twenty minutes. They want to know what is ` +
        `here, how the pieces relate, and where to start. They do NOT want an API reference: signatures, exported ` +
        `names and option lists are already one \`iq outline\` away, and repeating them is the fastest way to make ` +
        `a document that is long, stale within a week, and unread.`,
    ``,
    `Write in plain language. Prefer a short sentence to a precise-sounding one. Expand an acronym the first ` +
        `time. When something is surprising, say that it is surprising and say why. When a design decision has a ` +
        `reason, give the reason; when you cannot find ` +
        `the reason, say what the code does and do not invent one.`,
    ``,
    `Length is a budget, not a target: one screen per package. If you cannot say what a package is for in one ` +
        `sentence, that difficulty is itself worth writing down.`,
].join(`\n`);

// The figure vocabulary, verbatim. This is the contract with @intentic/ui/markdown's figures.ts, a fence
// whose body does not parse renders as a code block, which is a visible, self-correcting failure.
const FIGURES = [
    `## Figures`,
    ``,
    `Put figures INLINE, at the sentence they illustrate, as fenced blocks whose language names the figure kind.`,
    `The body is JSON. A fence that does not parse renders as a plain code block, so keep it valid.`,
    ``,
    `A graph: components, dependencies, a request path. \`direction\` is "LR" (default) or "TB".`,
    `\`accent\` is "1".."5" or "neutral": assign a slot to a COMPONENT and reuse that same slot everywhere.`,
    ``,
    `\`\`\`dag`,
    `{ "title": "How a turn reaches the model", "direction": "LR",`,
    `  "nodes": [{ "id": "web", "label": "Browser app", "note": "Vue", "accent": "1" },`,
    `            { "id": "daemon", "label": "Sandbox daemon", "note": "one per box", "accent": "2" }],`,
    `  "edges": [{ "from": "web", "to": "daemon" }] }`,
    `\`\`\``,
    ``,
    `A magnitude comparison across a few named things. ONE measure per figure; \`display\` is the tip label.`,
    ``,
    `\`\`\`bars`,
    `{ "title": "Lines of code", "items": [{ "label": "_editor/web", "value": 77114, "display": "77.1k" }] }`,
    `\`\`\``,
    ``,
    `An orientation strip of counts. Values are TEXT, so write the units you mean.`,
    ``,
    `\`\`\`stats`,
    `{ "items": [{ "label": "Packages", "value": "53", "note": "18 with tests" }] }`,
    `\`\`\``,
    ``,
    `Edges carry no labels (the renderer draws paths, not text on paths). Use \`"dashed": true\` for a weaker or ` +
        `dev-only relationship. Do not describe a figure in prose as well as drawing it. Say the thing the figure ` +
        `cannot: what to notice in it.`,
].join(`\n`);

/* What a PACKAGE agent may draw, which is much less than the map may, and deliberately so. Sizes, file counts
 * and neighbour lists are computed by `intentic-docs check` and drawn by the app above the prose, so a page that
 * writes them by hand is duplicating a fact it will not be around to update. That duplication was 62% of the
 * bytes in the layout this replaced, and the largest single source of rot in it. */
const PACKAGE_FIGURES = [
    `## Figures`,
    ``,
    `**Do not draw the facts.** This package's size, its file count, whether it has tests and which packages it ` +
        `depends on are computed and drawn above your prose automatically. Writing them into the page yourself ` +
        `duplicates a number that goes stale the next time anyone commits.`,
    ``,
    `Draw a figure only for something the dependency graph cannot say (a request's path, a state machine, an ` +
        `ordering). Then put it INLINE, at the sentence it illustrates, as a fence whose body is JSON. A fence that ` +
        `does not parse renders as a plain code block, so keep it valid.`,
    ``,
    `\`\`\`dag`,
    `{ "title": "How a turn reaches the model", "direction": "LR",`,
    `  "nodes": [{ "id": "web", "label": "Browser app", "note": "Vue", "accent": "1" },`,
    `            { "id": "daemon", "label": "Sandbox daemon", "note": "one per box", "accent": "2" }],`,
    `  "edges": [{ "from": "web", "to": "daemon" }] }`,
    `\`\`\``,
    ``,
    `\`direction\` is "LR" (default) or "TB". \`accent\` is "1".."5" or "neutral" and belongs to a COMPONENT. Reuse ` +
        `your component's slot. Edges carry no labels; use \`"dashed": true\` for a weaker or dev-only relationship. ` +
        `Do not describe a figure in prose as well as drawing it.`,
].join(`\n`);

/* Provenance takes its revision from the FACTS OUTPUT, not from the browser that started the run. The tool already
 * computes both, `head` for the repository, a per-package `sourceRev`, and it computes them inside the worktree
 * the agent is actually reading. A revision injected from the browser would be one more thing that can be subtly
 * wrong (a run started before a commit landed, a worktree at a different base) about the one field the staleness
 * check depends on. */
const provenanceRule = (source: string): string =>
    [
        `## Provenance is mandatory`,
        ``,
        `Every JSON document you write carries:`,
        ``,
        `    "provenance": { "sourceRev": "<see below>", "generatedAt": <epoch ms>, "model": "<the model you are>" }`,
        ``,
        `\`sourceRev\` is ${source} It is what makes rot detectable later: it is compared against the directory's ` +
            `current revision to answer "is this still true?". Take it from the tool's output. Do not invent one, and ` +
            `do not use a short sha.`,
    ].join(`\n`);

// Takes the repo flag rather than printing a `<repo>` placeholder: the brief already knows which repository this
// is, and a command the agent has to fill in is a command it can fill in wrong.
const validateRule = (repoFlag: string): string =>
    [
        `## Finish by validating`,
        ``,
        `\`intentic-docs\` is on your PATH. Before you finish:`,
        ``,
        `    intentic-docs validate${repoFlag} --from staging`,
        ``,
        `It checks that the map parses, that every package has a README, that each one opens with a lead sentence, ` +
            `and that every \`## Key files\` link still resolves. Fix what it reports and run it again until it ` +
            `passes. A key-files link pointing at a file that is not there is the clearest possible signal that a ` +
            `page is wrong, so it is worth getting right rather than working around.`,
    ].join(`\n`);

export interface MapBriefInput {
    // Root-relative repo dir; "" is the workspace's own root repo.
    readonly repo: string;
    // Its display name, what the prose should call it.
    readonly label: string;
}

/* The map phase. It writes exactly two files and deliberately documents NO package: its whole job is the
 * structure the package agents then share, and a map agent that starts writing package prose spends its context
 * on one package instead of the shape of all of them. */
export const mapBrief = (input: MapBriefInput): string => {
    const { repo, label } = input;
    const repoFlag = repo === `` ? `` : ` --repo ${repo}`;
    return [
        `You are writing the MAP for the repository "${label}": the top of a documentation set that other agents ` +
            `will then fill in, one package each. You are not documenting any single package.`,
        ``,
        AUDIENCE,
        ``,
        `## Start from the facts, not from reading`,
        ``,
        `Run this first:`,
        ``,
        `    intentic-docs facts${repoFlag}`,
        ``,
        `It gives you every package in the repository, the dependency edges between them, each one's size and ` +
            `whether it has tests. That is your ground truth for structure, so do not restate it from reading, and do ` +
            `not contradict it. Read source only to understand what things are FOR: \`iq map\`, \`iq outline\` and the ` +
            `repo's own README/ARCHITECTURE files will take you further per token than opening files.`,
        ``,
        `## What to decide`,
        ``,
        `**Logical components.** Group the packages into the handful of things a reader actually thinks in ("the ` +
            `control plane", "the wire", "the browser app"). Only this step can make these groupings; no single-package ` +
            `agent sees enough to do it. A component is not a directory: it is a job. Aim for 4–9 of them; a ` +
            `component per package is not a map, and two components for forty packages is not either. Every package ` +
            `should belong to exactly one.`,
        ``,
        `**Vocabulary.** List the terms this repo uses in a way an outsider would guess wrong. Every package agent ` +
            `is handed this glossary, so it is what stops the set from inventing a different word per page.`,
        ``,
        `**Reading order.** The packages a newcomer should open first, in order. Three to six, not a ranking of all ` + `of them.`,
        ``,
        `## Write exactly two files`,
        ``,
        `**${stagingPath(repo, REPO_DOC_TAIL)}**`,
        ``,
        `    {`,
        `      "repo": ${JSON.stringify(repo)},`,
        `      "components": [{ "id": "wire", "name": "The wire", "oneLiner": "One sentence.",`,
        `                       "packages": ["_sandbox/sandbox-contract"], "accent": "1" }],`,
        `      "glossary": [{ "term": "panel", "means": "One sentence, plain language." }],`,
        `      "reading": ["_sandbox/sandbox-contract", "_sandbox/sandbox"],`,
        `      "provenance": { … }`,
        `    }`,
        ``,
        `Give each component a distinct \`accent\` from "1".."5", and "neutral" for any past the fifth. The package ` +
            `agents reuse their component's slot in every figure they draw, which is what makes the diagrams across ` +
            `the set read as one system.`,
        ``,
        `**${stagingPath(repo, REPO_PROSE_TAIL)}**: the repository's own page, in prose, with figures. What is this ` +
            `repo, what are the components and how do they relate, what should I read first, and what would surprise ` +
            `me. Open with a \`stats\` figure and include a \`dag\` of the components. This is the page someone reads ` +
            `before anything else, so it is worth more care than any single package page.`,
        ``,
        FIGURES,
        ``,
        provenanceRule(`the \`head\` field of the \`intentic-docs facts\` output you ran above.`),
        ``,
        `## Rules`,
        ``,
        `- Write ONLY into \`${stagingDir(repo)}\`. Do not create or edit anything under the repository itself. The ` +
            `owner publishes these documents into the repo after reading them, and that is not your step.`,
        `- Do not modify the code you are documenting. If you find a bug, write it down in the prose; do not fix it.`,
        `- JSON with keys in a stable order and two-space indent. These files are reviewed as diffs.`,
        `- \`${INDEX_TAIL}\` is generated by \`intentic-docs check\`. Never write it by hand.`,
        ``,
        validateRule(repoFlag),
    ].join(`\n`);
};

export interface PackageBriefInput {
    readonly repo: string;
    readonly label: string;
    // Repo-relative package dir, the document's identity.
    readonly dir: string;
    // The component this package was assigned by the map phase, when the map placed it in one.
    readonly component?: DocComponent | undefined;
    // The map's shared vocabulary, inlined rather than referenced: it is small, and it is the whole mechanism by
    // which independently-written pages agree on what words mean.
    readonly glossary: readonly DocTerm[];
    // Sibling components, named so a page can point at its neighbours without inventing names for them.
    readonly components: readonly DocComponent[];
}

export const packageBrief = (input: PackageBriefInput): string => {
    const { repo, label, dir, component, glossary, components } = input;
    const repoFlag = repo === `` ? `` : ` --repo ${repo}`;
    /* Assembled as BLOCKS joined by a blank line, not as lines joined by a newline: two of them are optional (a
     * repo may have no glossary, a package may sit in no component) and dropping an absent block must not also
     * drop the paragraph break around it. */
    const blocks: (string | undefined)[] = [
        `You are documenting ONE package: \`${dir}\` in the repository "${label}".`,
        AUDIENCE,
        `## Where this package sits`,
        component === undefined
            ? `The map did not assign this package to a component. Say what it belongs with, in one sentence, and ` +
              `move on, and do not redraw the map.`
            : `It belongs to the **${component.name}** component: ${component.oneLiner}\n\nUse accent slot ` +
              `"${component.accent ?? `neutral`}" for this component in every figure you draw, so the set's diagrams ` +
              `agree with each other.`,
        components.length === 0
            ? undefined
            : `The other components, so you can point at neighbours by their real names:\n\n${components
                  .map((other) => `- **${other.name}**: ${other.oneLiner}`)
                  .join(`\n`)}`,
        glossary.length === 0
            ? undefined
            : `## This repository's vocabulary\n\nUse these words to mean these things:\n\n${glossary
                  .map((term) => `- **${term.term}**: ${term.means}`)
                  .join(`\n`)}`,
        [`## Start from the facts`, ``, `    intentic-docs facts${repoFlag}`].join(`\n`),
        `Find \`${dir}\` in the output: its size, whether it has tests, and which ` +
            `packages it depends on and which depend on it. Those edges are what tells you whether this is a leaf ` +
            `everything uses or an entry point that uses everything. Do not restate numbers from reading; take them ` +
            `from here.`,
        `Then read enough to know what it is FOR. \`iq outline ${dir}\` is worth more per token than opening files. ` +
            `Long comments at the top of a file are usually the author explaining the design. Read those before the ` +
            `code under them. If the package already has a README, you are REVISING it, not replacing it: keep what ` +
            `is still true and fix what is not.`,
        `## Write exactly one file`,
        [
            `**${stagingPath(repo, packagePageTail(dir))}**: the package's README, which IS its documentation page.`,
            `There is no JSON sidecar: everything the app needs that is not prose gets read back out of this file.`,
            ``,
            `Two things are required, because a tool parses them:`,
            ``,
            `    # <the package's name, or its directory if it has none>`,
            ``,
            `    One sentence a stranger could repeat back. This becomes the package's one-liner everywhere it is`,
            `    named without being opened, so write a sentence, not a paragraph.`,
            ``,
            `    ## Key files`,
            ``,
            `    - [src/index.ts](src/index.ts): why this file is worth opening.`,
            ``,
            `\`## Key files\` is three to six entries. Link targets are relative to the PACKAGE directory (so the ` +
                `links work on GitHub and in the file tree) and must exist. Append \`#L42\` to a target for a line number.`,
        ].join(`\n`),
        `Everything else is yours to shape. \`## Responsibilities\`, \`## How it fits\` and \`## Conventions & gotchas\` ` +
            `are the usual spine and a good default: what this is and why it exists; how it fits the components ` +
            `around it; the two or three things you would have to explain to a new maintainer; what is surprising. ` +
            `No heading called "API". No list of exports.`,
        PACKAGE_FIGURES,
        [
            `## Rules`,
            ``,
            `- Write ONLY this one file, under \`${stagingDir(repo)}\`. Another agent is documenting each other ` +
                `package right now, and \`${REPO_DOC_TAIL}\` belongs to the map. Editing either is how a run corrupts ` +
                `itself.`,
            `- Do not modify the code you are documenting. Finding a defect is worth writing down; fixing it is ` + `someone else's turn.`,
            `- There is no provenance to write. The page's date is the commit that carries it, and how far the code ` +
                `has run ahead of it is a commit count. Both are computed, neither authored.`,
        ].join(`\n`),
        validateRule(repoFlag),
    ];
    return blocks.filter((block) => block !== undefined).join(`\n\n`);
};
