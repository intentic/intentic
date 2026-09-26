import { type Finding, type MainlinePush, pushFixBase, pushRedOf, type Red } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { publicPushReds } from "../../workspace/deps/push-checks-store.js";
import type { TurnInput } from "../../seams/turn-starter.js";
import { daemonFixAttemptDeps, type FixAttemptOutcome, startFixAttempt } from "./fix-attempts.js";

// A conversation on what a push check let through, or on the push the repository's own hook refused, opened only when
// somebody presses for it (the Main line's "Hand to an agent", or the refused push's own card): the sandbox never starts
// one by itself (RED_POLICY: a push red waits for the owner). Both read the project's push Red, so there is one flow for
// either. Everything it owes goes into one conversation, named by when the red began (pushFixBase), so a second press
// while anything is owed continues the same attempt (fix-attempts.ts), exactly as a CI fix does.

// The registry's own cap on a title.
const TITLE_MAX = 80;
// Findings listed before the rest are counted; the owner's Main line lists them all.
const FINDINGS_LISTED = 40;
const NUDGE_LISTED = 15;

export interface PushFixBrief {
    readonly base: string;
    readonly title: string;
    readonly prompt: string;
    readonly nudge: string;
}

const where = (project: string): string => (project === "" ? "the workspace root" : `\`${project}\``);

const short = (sha: string): string => sha.slice(0, 7);

// Which group a finding reads under, by what measured it (the repository's own name for it), in the order the brief
// lists them: what the tree fails whoever caused it, then the lines the push added, then anything else a measurement can
// clear, then what is about the pushed commits themselves.
const groupOf = (finding: Finding): { readonly rank: number; readonly heading: string } => {
    const source = `\`${finding.source}\``;
    if (!finding.recheckable) {
        return { rank: 3, heading: `${source}, about the pushed commits themselves:` };
    }
    return finding.gate === "code"
        ? { rank: 0, heading: `${source}, which the tree fails whoever caused it:` }
        : finding.gate === "tidy"
          ? { rank: 1, heading: `${source}, on lines the push added:` }
          : { rank: 2, heading: `${source}:` };
};

// A finding's own words as a list item: some checks print theirs as one already, and "- - x" helps nobody.
const itemOf = (finding: Finding): string => `- ${finding.text.replace(/^[-*]\s+/, "")}`;

const findingLines = (finding: Finding): string[] => [itemOf(finding), ...(finding.command === undefined ? [] : [`  \`${finding.command}\``])];

// The findings grouped by what printed them, code-gate checks first; within a group, in the order they were found.
const groupedFindings = (findings: readonly Finding[]): string => {
    const groups = new Map<string, { readonly rank: number; readonly lines: string[] }>();
    for (const finding of findings.slice(0, FINDINGS_LISTED)) {
        const { rank, heading } = groupOf(finding);
        const group = groups.get(heading) ?? { rank, lines: [] };
        group.lines.push(...findingLines(finding));
        groups.set(heading, group);
    }
    const rest = findings.length - FINDINGS_LISTED;
    return [
        ...[...groups.entries()]
            .toSorted(([, left], [, right]) => left.rank - right.rank)
            .map(([heading, { lines }]) => [heading, ...lines].join("\n")),
        ...(rest > 0 ? [`…and ${rest} more, listed on the owner's Main line.`] : []),
    ].join("\n\n");
};

// A refused push's one finding is the hook's own output, quoted whole rather than listed as a line.
const refusalLines = (push: MainlinePush, open: readonly Finding[]): string =>
    [
        `The push of \`${short(push.head)}\`${push.branch === undefined ? "" : ` to ${push.remote === undefined ? push.branch : `${push.remote}/${push.branch}`}`} was refused by the repository's own pre-push hook, so nothing reached the remote. What it said (the end of it):`,
        ...open.map((finding) => `\`\`\`\n${finding.text}\n\`\`\``),
        `Find the cause and fix it, then confirm the hook passes: \`git push --dry-run\` runs it without sending anything.`,
    ].join("\n\n");

// One pushed range as the brief names it, with the commits its open findings came with.
const pushLines = (push: MainlinePush, open: readonly Finding[]): string => {
    const range =
        push.base === undefined
            ? `\`${short(push.head)}\` (the remote had nothing to compare it with)`
            : `\`${short(push.base)}..${short(push.head)}\``;
    const to = push.remote === undefined ? (push.branch ?? "") : push.branch === undefined ? push.remote : `${push.remote}/${push.branch}`;
    const commits = new Map(open.flatMap((finding) => (finding.commit === undefined ? [] : [[finding.commit.sha, finding.commit.subject] as const])));
    return [
        `- ${range}${to === "" ? "" : ` to ${to}`}, ${push.commits} commit${push.commits === 1 ? "" : "s"}`,
        ...[...commits].map(([sha, subject]) => `  - ${short(sha)} ${subject}`),
    ].join("\n");
};

// The opening prompt, the nudge a continued attempt gets, and the id attempt 1 wears; undefined when nothing is owed.
export const pushFixBrief = (pushes: readonly MainlinePush[], red: Red | undefined): PushFixBrief | undefined => {
    const base = pushFixBase(red);
    if (red === undefined || base === undefined || red.findings.length === 0) {
        return undefined;
    }
    const project = red.scope;
    const owed = new Set(red.findings.map((finding) => finding.id));
    const openOf = (push: MainlinePush): Finding[] => push.findings.filter((finding) => owed.has(finding.id));
    // Oldest push first, so the ranges read in the order they were pushed.
    const holding = pushes.filter((push) => push.project === project && openOf(push).length > 0).toReversed();
    const refused = holding.filter((push) => push.refused === true);
    const refusals = new Set(refused.flatMap(openOf).map((finding) => finding.id));
    const left = holding.filter((push) => push.refused !== true);
    const open = red.findings;
    const leftOpen = open.filter((finding) => !refusals.has(finding.id));
    const pushedCommits = leftOpen.some((finding) => !finding.recheckable);
    const prompt = [
        ...refused.map((push) => refusalLines(push, openOf(push))),
        ...(leftOpen.length === 0
            ? []
            : [
                  `The push check in ${where(project)} let the findings below through. It only reports, so nothing blocked the push, and they still stand.`,
                  ...(left.length === 0 ? [] : [`What was pushed:\n${left.map((push) => pushLines(push, openOf(push))).join("\n")}`]),
                  `What it found, by what measured it:\n\n${groupedFindings(leftOpen)}`,
                  `Fix them in the code, and confirm each one by re-running the command next to it. The owner's Main line clears a finding once a measurement no longer prints it.`,
              ]),
        ...(pushedCommits ? [`Findings about the pushed commits themselves concern commits that are already pushed, so their fix is a follow-up commit.`] : []),
        `You are in an isolated worktree: commit your fix and it goes through review.`,
    ].join("\n\n");
    const listed = open.slice(0, NUDGE_LISTED).map(itemOf);
    const nudge = [
        refused.length > 0
            ? `The push in ${where(project)} is still refused by its pre-push hook, or not all of what the push check let through is fixed yet, and this conversation is the attempt at it. Still open:`
            : `What the push check let through in ${where(project)} is not all fixed yet, and this conversation is the attempt at it. Still open:`,
        [...listed, ...(open.length > NUDGE_LISTED ? [`- …and ${open.length - NUDGE_LISTED} more`] : [])].join("\n"),
        `Carry on from where you left off, and confirm each one with the command next to it earlier in this conversation.`,
    ].join("\n\n");
    return { base, title: `Fix what the push left: ${project === "" ? "workspace" : project}`.slice(0, TITLE_MAX), prompt, nudge };
};

export interface PushFixRequest {
    readonly project: string;
    // What the turn carries besides its words: the pick, who pressed.
    readonly turn?: Omit<TurnInput, "prompt" | "conversationId" | "title" | "isolated" | "runRole">;
    // Whether a model was picked for this press, which outranks re-running a turn the door kept.
    readonly picked: boolean;
    readonly resume?: Parameters<typeof startFixAttempt>[1]["resume"];
}

// Starts, continues or declines the attempt at what the project's push red owes; undefined when nothing is owed. A start
// is filed on the red as its decision, so the record says who has it.
export const startPushFix = async (services: Services, request: PushFixRequest): Promise<FixAttemptOutcome | undefined> => {
    const state = await services.pushChecks.store.read();
    const brief = pushFixBrief(state.pushes, pushRedOf(publicPushReds(state.reds), request.project));
    if (brief === undefined) {
        return undefined;
    }
    const outcome = await startFixAttempt(daemonFixAttemptDeps(services, { pressed: true, picked: request.picked }), {
        ...brief,
        errands: { prompt: "push-fix", nudge: "push-fix-nudge" },
        // `runRole` alone pins the model (turn-resume.ts) when nobody picked one: the pre-push fix's own list, which the
        // Main line's caret reads too, so the model it shows is the model that runs. The pick and who pressed ride in `turn`.
        turn: { isolated: true, runRole: "pre-push-fix", ...request.turn },
        resume: request.resume,
    });
    if (outcome.kind === "started") {
        await services.pushChecks.handed(request.project, outcome.conversationId);
    }
    return outcome;
};
