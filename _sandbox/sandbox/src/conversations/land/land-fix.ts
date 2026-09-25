import { landFixConversationId, landFixPrompt } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Services } from "../../composition.js";
import { daemonFixAttemptDeps, type FixAttemptOutcome, startFixAttempt } from "../fix/fix-attempts.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import type { LandBreakage } from "../../workspace/deps/verify-deps.js";

// A FRESH conversation on a red main-line check, for the reds no conversation still holding the work could take: nobody
// could be named, several could, or the one named had gone cold or run out of room (land-breakage.ts decides which).
// One red streak is one failure: every attempt at it shares an id derived from where the streak began, so a second
// start continues the first rather than racing it (conversations/fix/fix-attempts.ts), exactly as a CI fix does.

// Failures listed before the rest are counted; files listed per suspect before the rest are.
const FAILURES_LISTED = 30;
const FILES_LISTED = 20;
// The registry's own cap on a title.
const TITLE_MAX = 80;

// One land the failures may have come with, as the brief shows it: what it changed and how to read its conversation.
export interface LandSuspect {
    readonly land: DependencyLandOrigin;
    // Repo-relative paths it changed in the project's repository.
    readonly paths: readonly string[];
    // The main-line commit it departed from and the branch commit it landed, for a `git diff` of exactly its change.
    readonly from: string | undefined;
    readonly tip: string | undefined;
}

export interface LandFixAsk {
    readonly breakage: LandBreakage;
    // The lands the failures were laid at, or every land the red run covered when none could be named alone.
    readonly suspects: readonly LandSuspect[];
    // Whether blame narrowed them to these; false hands the fix-up every land to tell apart itself.
    readonly named: boolean;
    // Why the conversation that landed it is not taking it, in a sentence, when one was named.
    readonly passedOver?: string | undefined;
}

const where = (project: string): string => (project === "" ? "the workspace root" : `\`${project}\``);

const listed = (items: readonly string[], limit: number): string[] => [
    ...items.slice(0, limit).map((item) => `- ${item}`),
    ...(items.length > limit ? [`- …and ${items.length - limit} more`] : []),
];

const suspectLines = (suspect: LandSuspect, repoDir: string): string => {
    const { land } = suspect;
    const name = land.title === undefined ? `\`${land.agentId}\`` : `"${land.title}" (\`${land.agentId}\`)`;
    return [
        `**${name}**`,
        ...listed(suspect.paths, FILES_LISTED),
        ...(suspect.from !== undefined && suspect.tip !== undefined ? [`Its change alone: \`git -C ${repoDir} diff ${suspect.from} ${suspect.tip}\``] : []),
        `What it was asked and what it did: \`agents show ${land.agentId}\``,
    ].join("\n");
};

// How to check a fix without running the whole suite again: the command that failed is the machine's heaviest, it runs on
// the main tree again the moment the fix lands, and a conversation that re-runs it takes the memory every other one needs.
export const narrowCheckOf = (command: string): string =>
    `Check the fix by re-running only the failing tests and the typecheck of the package you change, not \`${command}\` or anything else across the whole repository: that runs again on the main tree when your fix lands.`;

// The brief a fresh fix-up opens on: the failures, the suspects' changes and where to read their conversations, and
// how to tell several suspects apart without running the whole suite again.
export const landFixBrief = (ask: LandFixAsk, repoDir: string): string => {
    const { breakage, suspects } = ask;
    return landFixPrompt([
        `\`${breakage.command}\` in ${where(breakage.project)} failed on:`,
        listed(breakage.fresh, FAILURES_LISTED).join("\n"),
        ask.named
            ? `These failures arrived with ${suspects.length === 1 ? "this land" : "one of these lands"}:`
            : `No single land could be named for them; these are every land the red check covered:`,
        suspects.map((suspect) => suspectLines(suspect, repoDir)).join("\n\n"),
        ...(ask.passedOver === undefined ? [] : [ask.passedOver]),
        [
            `Start by re-running only the failing tests; they fail on the main tree now, and your worktree starts from it.`,
            ...(suspects.length > 1
                ? [`With several suspects, tell them apart before changing anything: re-run the failing tests with one suspect's change reverted in your worktree at a time.`]
                : []),
            `If a suspect's conversation is still open, its own record says what it meant to do; keep that intent and fix the break.`,
            narrowCheckOf(breakage.command),
        ].join(" "),
        `The end of the check's output:\n\n\`\`\`\n${breakage.logTail.trim()}\n\`\`\``,
    ]);
};

// What a continued attempt is told: the failure is still open, the evidence is already in the conversation.
const nudgeOf = (breakage: LandBreakage): string =>
    [
        `The main tree's check in ${where(breakage.project)} is still red on the failures this conversation was started for, and it is the attempt at them. Your earlier turn ended without them passing on the main tree.`,
        `Carry on from where you left off; the failures and suspects earlier in this conversation are still the evidence.`,
    ].join("\n\n");

const titleOf = (ask: LandFixAsk): string => {
    const first = ask.named && ask.suspects.length === 1 ? ask.suspects[0]?.land.title : undefined;
    return (first === undefined ? `Fix main: ${ask.breakage.project === "" ? "workspace" : ask.breakage.project}` : `Fix main after "${first}"`).slice(0, TITLE_MAX);
};

// Starts, continues or declines the attempt at this red streak; `busy` names the attempt already working on it.
export const startLandFix = (services: Services, ask: LandFixAsk): Promise<FixAttemptOutcome> =>
    startFixAttempt(daemonFixAttemptDeps(services, { byPerson: false, picked: false }), {
        base: landFixConversationId(ask.breakage.project, ask.breakage.redSince),
        prompt: landFixBrief(ask, services.agentWorktrees.mainDir(ask.breakage.project === "" ? "root" : ask.breakage.project)),
        nudge: nudgeOf(ask.breakage),
        title: titleOf(ask),
        // `runRole` alone pins the model (turn-resume.ts); a red main line is fixed by the same kind of agent a red
        // pipeline is, so it shares that role's pick.
        turn: { isolated: true, runRole: `pipeline-fix` },
    });

// The paths a land changed in the project's repository, from the commit it departed to the tip it landed; empty when
// either end is unknown. `from`/`tip` ride along so the brief can name the exact diff.
export const landChange = async (
    services: Pick<Services, "agentWorktrees" | "logger">,
    land: DependencyLandOrigin,
    project: string,
    tipOf: (land: DependencyLandOrigin, repo: string) => string | undefined,
    git: GitRunner = defaultGit,
): Promise<LandSuspect> => {
    const span = land.repos.find(({ repo }) => (repo === "root" ? "" : repo) === project);
    const tip = span === undefined ? undefined : tipOf(land, span.repo);
    if (span === undefined || tip === undefined) {
        return { land, paths: [], from: span?.from, tip };
    }
    try {
        const { stdout } = await git(services.agentWorktrees.mainDir(span.repo), ["diff", "--name-only", "--no-renames", span.from, tip]);
        return { land, paths: stdout.split("\n").filter((path) => path !== ""), from: span.from, tip };
    } catch (error) {
        // A land whose commits git no longer has names no paths, which leaves it a suspect only when nothing else is.
        services.logger.warn({ err: error, conversationId: land.agentId, project }, "land breakage: a land's changed paths could not be read");
        return { land, paths: [], from: span.from, tip };
    }
};
