import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/sandbox-contract";
import { reportPath, resultPath, type RunStory, storyDir } from "./runs";

// The brief is the daemon's only per-conversation specialization seam (the system prompt is sandbox-wide); this is
// where an acceptance session's rules live, and each was a real failure mode when missing.
// 1. The story is inlined, not referenced, so the agent tests the app rather than the code it just read.
// 2. Authored criteria are enumerated and numbered, so the result's positional criteria array lines up against what was
//    promised.
// 3. The browser must be named explicitly, since its tools are deferred and an untold agent reaches for curl instead.
// 4. Screenshots are copied into the story's own shots/ immediately, since the daemon's hook flattens every run's shots
//    into one shared, model-named directory.
// 5. It is a tester, not a developer: fixing a bug it finds makes the report describe an app that no longer exists.

export interface BriefInput {
    // The manifest's own entry, not the listed story, since the run recorded this exact conversation and directory.
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
    `You are a TESTER, not a developer. Do not modify the application's source. Do not fix defects you find. ` +
        `Finding them is the deliverable, and a fixed defect is one the report can no longer describe. The only ` +
        `files you write are your own report and screenshots, in the run directory named below.`,
].join(`\n`);

// Criteria restated as the contract the result is judged against, numbered since the result's criteria array is
// positional. An unauthored list isn't an error: the agent derives criteria from the prose instead.
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
              `Your result file must carry exactly these ${list.length}, in this order, one verdict each. Quote each ` +
                  `criterion verbatim. Do not merge them, do not reword them, and do not add your own to the list: ` +
                  `anything else you find belongs in \`defects\`, which is where an unpromised problem is still worth reporting.`,
          ].join(`\n`);

const method = (baseUrl: string): string =>
    [
        `## Method`,
        ``,
        `1. Put the criteria above into a checklist (ToolSearch \`select:TaskCreate,TaskUpdate,TaskList\`), one task per criterion. Keep it current; it is how the run is watched.`,
        `2. Open ${baseUrl} and screenshot the entry point before touching anything.`,
        `3. Walk each criterion the way a user would: act, take a snapshot to see the result, screenshot it, and judge it against what the story says should happen. Prefer \`browser_snapshot\` over screenshots for READING the page because it is text and it is what you click by.`,
        `4. Then go off-script, because a criteria list is a floor and not a ceiling: empty and invalid input, submitting twice, the back button, a reload mid-flow, a narrow viewport (\`browser_resize\`). Record what you tried even when nothing broke. "Tried, held up" is a finding.`,
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
        `Console errors and failed requests are evidence. Check \`browser_console_messages\` and ` +
            `\`browser_network_requests\` when something looks wrong, and quote them in the defect.`,
        ``,
        `### Screenshots: read this before you take the first one`,
        ``,
        `Every screenshot lands in \`${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser\` whatever filename you pass; the harness rewrites ` +
            `it and that directory is SHARED with the other tests running right now. So:`,
        ``,
        `- Name each shot \`${"<NN>"}-${"<short-step>"}.png\`, e.g. \`01-signin-form.png\`, \`02-validation-error.png\`. Numbers in the order you took them.`,
        `- Immediately after each shot, copy it into your own directory: \`cp ${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser/${"<name>"}.png ${shots}/${"<name>"}.png\`. Do it per shot, not in a batch at the end, because after the fact you cannot tell which step a file belonged to.`,
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
            `even when the verdict is \`fail\` or \`blocked\`. An absent report is indistinguishable from a crashed test.`,
        ``,
        `**\`${params.report}\`**: the walkthrough a human reads. Open with the verdict and one sentence of why. Then ` +
            `the steps in order as prose, each with its screenshot inline. Then the defects, worst first. Write what you ` +
            `SAW, not what you expected to see.`,
        ``,
        `**\`${params.result}\`**: the same run as data, in exactly this shape:`,
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
            `all. \`defects\` is \`[]\` when there are none. Omit nothing.`,
    ].join(`\n`);

export const briefFor = (input: BriefInput): string => {
    const dir = `${WORKSPACE_ROOT}/${storyDir(input.runId, input.story.slug)}`;
    const sections = [
        HEADER,
        [
            `## The story`,
            ``,
            `From \`${input.story.path}\` in the \`${input.story.repo}\` repository. Test what it says, not what the code does. ` +
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
    // Project notes go last, so they read as amendments (a login to use, a fixture, a flow to avoid) rather than
    // context the instructions above then contradict.
    const notes = input.projectNotes?.trim();
    return (notes === undefined || notes === `` ? sections : [...sections, [`## Project-specific testing notes`, ``, notes].join(`\n`)]).join(`\n\n`);
};
