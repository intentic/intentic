import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/sandbox-contract";
import { reportPath, resultPath, type RunStory, storyDir } from "./runs";

/* THE BRIEF — what makes a test session a test session.
 *
 * The daemon has exactly one per-conversation specialization seam: the turn's PROMPT. The system prompt is a
 * sandbox-wide setting (three bases, one owner-chosen), so "a slightly specialized acceptance-testing session"
 * cannot be a different system prompt without changing what every other conversation in the sandbox runs on.
 * That is fine — everything this needs to say is task instruction, which is what a prompt is for.
 *
 * Five things it has to get right, each of which cost something real when it was missing:
 *
 * 1. THE STORY IS INLINED, not referenced. Handing the agent a path spends a Read, and worse, invites it to go
 *    read the implementation next — at which point it is testing the code it just read rather than the app a
 *    user meets. The story text and the base URL are the whole world it needs.
 *
 * 2. THE AUTHORED CRITERIA ARE ENUMERATED AND NUMBERED. They are already in the inlined story, but as prose in a
 *    checklist an agent is free to paraphrase, merge or reorder — and a report whose criteria are the agent's
 *    paraphrase cannot be read against what someone promised. Repeating them as a numbered list with "return
 *    exactly these, in this order" is what turns the result file into a matrix the view can line up.
 *
 * 3. THE BROWSER MUST BE NAMED. Its ~20 tools are DEFERRED (isolatedBrowserSpec keeps them out of every turn's
 *    prompt), so an agent that is not told to ToolSearch for them reaches for curl, gives up on anything
 *    client-rendered, or installs its own Playwright.
 *
 * 4. SCREENSHOTS DO NOT GO WHERE THE MODEL ASKS. The daemon's PreToolUse hook rewrites every screenshot's
 *    filename into the shared, FLAT `.intentic/artifacts/browser` — model-chosen names and all — and every agent in
 *    a run shares that directory. So names must be namespaced by story, and each shot copied into the story's
 *    own `shots/` immediately: copying at the end means reconstructing which step each file belonged to, and
 *    that is exactly the information a report exists to carry.
 *
 * 5. IT IS A TESTER, NOT A DEVELOPER. Left unsaid, a coding agent that finds a bug fixes it — which is the one
 *    outcome that makes the run worthless, because the report then describes an app that no longer exists.
 */

export interface BriefInput {
    // The MANIFEST's entry, not the story as listed: the brief is built from what was written to disk, so the
    // conversation the turn is started on and the directory it writes into are the ones the run recorded.
    readonly story: RunStory;
    readonly runId: string;
    // Where the app under test answers, from the extension's perspective at run time.
    readonly baseUrl: string;
    // The story's repo's docs/user-stories/.acceptance.md, when it ships one.
    readonly projectNotes?: string | undefined;
}

const HEADER = [
    `You are running an ACCEPTANCE TEST of one user story against a running application.`,
    ``,
    `You are a TESTER, not a developer. Do not modify the application's source. Do not fix defects you find — ` +
        `finding them is the deliverable, and a fixed defect is one the report can no longer describe. The only ` +
        `files you write are your own report and screenshots, in the run directory named below.`,
].join(`\n`);

/* The criteria, restated as the contract the result file is judged against. Numbered because the result's
 * `criteria` array is positional — "criterion 3 failed" has to mean the same thing to the agent, the report and
 * the person who wrote the story.
 *
 * A story that authored none is not an error: the brief asks the agent to derive them from the prose instead,
 * which is what every story did before the section existed. */
const criteria = (list: readonly string[]): string =>
    list.length === 0
        ? [
              `## Acceptance criteria`,
              ``,
              `This story declares no explicit criteria section, so derive them: read the story and write out the ` +
                  `specific, checkable claims it makes about the application. Those are what you test, and what you report a verdict for.`,
          ].join(`\n`)
        : [
              `## Acceptance criteria`,
              ``,
              `These are the story's OWN criteria, as its author wrote them. Test every one:`,
              ``,
              ...list.map((text, index) => `${index + 1}. ${text}`),
              ``,
              `Your result file must carry exactly these ${list.length}, in this order, one verdict each — quote each ` +
                  `criterion verbatim. Do not merge them, do not reword them, and do not add your own to the list: ` +
                  `anything else you find belongs in \`defects\`, which is where an unpromised problem is still worth reporting.`,
          ].join(`\n`);

const method = (baseUrl: string): string =>
    [
        `## Method`,
        ``,
        `1. Put the criteria above into a checklist (ToolSearch \`select:TaskCreate,TaskUpdate,TaskList\`), one task per criterion. Keep it current — it is how the run is watched.`,
        `2. Open ${baseUrl} and screenshot the entry point before touching anything.`,
        `3. Walk each criterion the way a user would: act, take a snapshot to see the result, screenshot it, and judge it against what the story says should happen. Prefer \`browser_snapshot\` over screenshots for READING the page — it is text, and it is what you click by.`,
        `4. Then go off-script, because a criteria list is a floor and not a ceiling: empty and invalid input, submitting twice, the back button, a reload mid-flow, a narrow viewport (\`browser_resize\`). Record what you tried even when nothing broke — "tried, held up" is a finding.`,
        `5. If the app is broken UPSTREAM of this story (it will not start, you cannot sign in, the page 500s), stop and record \`blocked\` with the exact wall you hit. Do not test around it and do not repair it.`,
    ].join(`\n`);

const tooling = (shots: string): string =>
    [
        `## Tools`,
        ``,
        `You drive a real Chromium. Its tools are deferred, so load them first: \`ToolSearch\` with \`+browser\` gives you ` +
            `\`mcp__web__browser_navigate\`, \`_snapshot\`, \`_click\`, \`_type\`, \`_fill_form\`, \`_press_key\`, \`_resize\`, ` +
            `\`_console_messages\`, \`_network_requests\` and \`_take_screenshot\`.`,
        ``,
        `The owner can watch this browser live and take control of it, so drive it as if someone is looking over your ` +
            `shoulder: one deliberate action at a time, and leave the page on whatever you last looked at.`,
        ``,
        `Console errors and failed requests are evidence — check \`browser_console_messages\` and ` +
            `\`browser_network_requests\` when something looks wrong, and quote them in the defect.`,
        ``,
        `### Screenshots — read this before you take the first one`,
        ``,
        `Every screenshot lands in \`${WORKSPACE_ROOT}/${STATE_DIR}/artifacts/browser\` whatever filename you pass; the harness rewrites ` +
            `it and that directory is SHARED with the other tests running right now. So:`,
        ``,
        `- Name each shot \`${"<NN>"}-${"<short-step>"}.png\` — \`01-signin-form.png\`, \`02-validation-error.png\`. Numbers in the order you took them.`,
        `- Immediately after each shot, copy it into your own directory: \`cp ${WORKSPACE_ROOT}/${STATE_DIR}/artifacts/browser/${"<name>"}.png ${shots}/${"<name>"}.png\`. Do it per shot, not in a batch at the end — after the fact you cannot tell which step a file belonged to.`,
        `- Reference shots in your report by the path relative to your report file: \`![](shots/01-signin-form.png)\`.`,
    ].join(`\n`);

const output = (params: {
    readonly slug: string;
    readonly title: string;
    readonly dir: string;
    readonly report: string;
    readonly result: string;
    readonly criteria: readonly string[];
}): string =>
    [
        `## What you leave behind`,
        ``,
        `Your run directory is \`${params.dir}\` (create it, plus \`shots/\`). Two files, both required, both written ` +
            `even when the verdict is \`fail\` or \`blocked\` — an absent report is indistinguishable from a crashed test.`,
        ``,
        `**\`${params.report}\`** — the walkthrough a human reads. Open with the verdict and one sentence of why. Then ` +
            `the steps in order as prose, each with its screenshot inline. Then the defects, worst first. Write what you ` +
            `SAW, not what you expected to see.`,
        ``,
        `**\`${params.result}\`** — the same run as data, in exactly this shape:`,
        ``,
        `\`\`\`json`,
        JSON.stringify(
            {
                story: params.slug,
                title: params.title,
                verdict: `pass | fail | blocked`,
                criteria: (params.criteria.length === 0 ? [`the criterion, as the story states it`] : params.criteria).map((text) => ({
                    text,
                    verdict: `pass | fail | untested`,
                    note: `why, in one line`,
                })),
                steps: [{ n: 1, action: "what you did", expected: "what the story says", observed: "what happened", shot: "shots/01-....png" }],
                defects: [
                    { severity: "blocker | major | minor", summary: "one line", repro: "the shortest path to see it", shot: "shots/04-....png" },
                ],
            },
            null,
            2,
        ),
        `\`\`\``,
        ``,
        `\`verdict\` is \`pass\` only if every criterion passed. \`blocked\` means you could not exercise the story at ` +
            `all. \`defects\` is \`[]\` when there are none — omit nothing.`,
    ].join(`\n`);

export const briefFor = (input: BriefInput): string => {
    const dir = `${WORKSPACE_ROOT}/${storyDir(input.runId, input.story.slug)}`;
    const sections = [
        HEADER,
        [
            `## The story`,
            ``,
            `From \`${input.story.path}\` in the \`${input.story.repo}\` repository. Test what it says, not what the code does — ` +
                `if the two disagree, that disagreement is the finding.`,
            ``,
            `---`,
            input.story.content.trim(),
            `---`,
        ].join(`\n`),
        criteria(input.story.criteria),
        [
            `## The application under test`,
            ``,
            `Base URL: ${input.baseUrl}`,
            ``,
            `It is already running. Do not start, build, restart or reconfigure it.`,
        ].join(`\n`),
        tooling(`${dir}/shots`),
        method(input.baseUrl),
        output({
            slug: input.story.slug,
            title: input.story.title,
            dir,
            report: `${WORKSPACE_ROOT}/${reportPath(input.runId, input.story.slug)}`,
            result: `${WORKSPACE_ROOT}/${resultPath(input.runId, input.story.slug)}`,
            criteria: input.story.criteria,
        }),
    ];
    // The repo's own notes go LAST so they read as amendments to the brief (a login to use, a seeded fixture, a
    // flow to avoid) rather than as context the instructions above then contradict.
    const notes = input.projectNotes?.trim();
    return (notes === undefined || notes === `` ? sections : [...sections, [`## Project-specific testing notes`, ``, notes].join(`\n`)]).join(`\n\n`);
};
