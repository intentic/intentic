import { driftWords } from "@intentic/sandbox-contract/events/child-news";
import { COMMIT_FIRST } from "@intentic/sandbox-contract/events/land-conflict";
import type { Services } from "../../composition.js";
import { deliverWake } from "../../seams/wake-delivery.js";
import { sayToParent } from "../land/child-lands.js";
import { landTargetOf, recordedTargetOf } from "../land/land-target.js";
import { decideLanding, resolvesAtOnce } from "../land/turn-landing.js";
import { conversationProfile, type IsolatedAgent } from "../registry/agents-store.js";
import type { DriftRepo } from "../registry/land-marks.js";
import { sharedTitleOf } from "../seal/seal-family.js";

// WHAT A DRIFT IS SAID AS, AND TO WHOM (branch-drift.ts finds it). Finished work held on its branch that no longer merges into
// what it lands on used to be met only at its land: in the shinobi-society audit (2026-11-17) three conversations
// finished between 01:42 and 06:21 and met their conflicts in the morning's landing batch, each fix re-opening a
// 350-634k-token session, and earlier "Couldn't rebase" notices had been acted on by nobody. Now it is said at once, to
// whoever can act while the clash is small, by the policy that already decides who resolves a land's clash
// (land/turn-landing.ts resolvesAtOnce):
// - a subagent whose work goes into a parent's checkout: its parent, while the parent has a live turn to hear it in;
// - a conversation whose finished work lands by itself, or a home conversation: a short resolve turn of its own, on its
//   warm session, once per drift (the mark's `asked`, cleared only when the branch merges again, so a resolve that did
//   not take is never asked twice);
// - anyone else, whose held work waits for a press anyway: a notice in its own record and an Activity row, and the
//   drift on `agents ls` and `agents show`. Nothing starts a turn for it. (A setting to start the resolve turn for held
//   work too is the owner's call, not taken here.)

// The opening a drift's resolve turn is told by, recognised by nothing but a reader: the turn is an errand like a land
// conflict's (`land-conflict`), its prompt its own, since no land was tried.
export const DRIFT_OPENING =
    "The main line moved after this conversation's work finished, and its branch no longer rebases onto it cleanly: nothing of it has landed, it is all still on your branch.";

// Files named per repo before the rest are counted; a resolve's rebase names every one as it stops on it.
const NAMED_PATHS = 12;

export type DriftNewsDeps = Pick<
    Services,
    "agents" | "conversations" | "agentWorktrees" | "transcripts" | "activity" | "turns" | "logger" | "sandboxSettings" | "auth" | "members" | "ownerEmail"
>;

const titleOf = (deps: Pick<DriftNewsDeps, "agents">, id: string): string | undefined => {
    const entry = deps.agents.entry(id);
    return entry === undefined ? undefined : sharedTitleOf(entry);
};

const nameOf = (deps: Pick<DriftNewsDeps, "agents">, id: string): string => {
    const title = titleOf(deps, id);
    return title === undefined ? `\`${id}\`` : `\`${id}\` ("${title}")`;
};

const filesClash = (files: number): string => `${files} file${files === 1 ? " clashes" : "s clash"}`;
const filesOf = (repos: readonly DriftRepo[]): number => repos.reduce((total, repo) => total + repo.paths.length + (repo.more ?? 0), 0);

// The conversations whose landed commits changed the clashing files, each named once.
const landersOf = (repos: readonly DriftRepo[]): string[] => [...new Set(repos.flatMap((repo) => repo.paths.flatMap((path) => path.by ?? [])))];

const repoLines = (deps: Pick<DriftNewsDeps, "agents">, repo: DriftRepo): string[] => [
    `${repo.repo}: \`git rebase ${repo.onto.slice(0, 12)}\``,
    ...repo.paths.slice(0, NAMED_PATHS).map(({ path, by }) => `  - ${path}${by === undefined || by.length === 0 ? "" : ` (changed by ${by.map((id) => nameOf(deps, id)).join(", ")}, landed)`}`),
    ...(repo.paths.length > NAMED_PATHS || (repo.more ?? 0) > 0 ? [`  - … +${repo.paths.length - Math.min(repo.paths.length, NAMED_PATHS) + (repo.more ?? 0)} more`] : []),
];

/** The resolve turn's prompt: what moved, what to run in each repo, the files that clash and who landed what they clash with. */
const driftPrompt = (deps: Pick<DriftNewsDeps, "agents">, repos: readonly DriftRepo[]): string =>
    [
        `${DRIFT_OPENING} Resolve it now, while the clash is small. In each repo below (\`root\` is your working directory, any other name that subdirectory of it):`,
        [
            COMMIT_FIRST,
            "2. Rebase onto the commit named for that repo, what this work lands on as it stands now. If the rebase gets away from you: `git rebase --abort`, then `git merge` that commit instead.",
            "3. Resolve each conflict keeping the intent of BOTH sides: your change and what moved underneath it.",
        ].join("\n"),
        repos.flatMap((repo) => repoLines(deps, repo)).join("\n"),
        "Then re-run the tests of the files you resolved, and only those. Stay inside your own worktree: when the turn ends, the work lands or waits on its branch as this conversation's work always does.",
    ].join("\n\n");

/** One line for a reader: the record's notice, the Activity row, and the line a parent's turn hears. */
const driftLine = (deps: Pick<DriftNewsDeps, "agents">, repos: readonly DriftRepo[]): string => {
    const landers = landersOf(repos);
    return (
        `The line this work lands on moved since it finished, and its branch no longer merges into it: ${filesClash(filesOf(repos))} in ${repos.map((repo) => repo.repo).join(", ")}` +
        `${landers.length === 0 ? "" : `, changed meanwhile by ${landers.map((id) => nameOf(deps, id)).join(", ")}`}.`
    );
};

// Whether this conversation's clash goes straight back to it: the rule a land's own clash follows (resolvesAtOnce), read
// as its land would decide now. Never for a last turn that failed or was stopped, which lands nothing by itself, nor while
// a message already waits for its next turn, which opens on the moved line anyway.
const resolvesByItself = async (deps: DriftNewsDeps, entry: IsolatedAgent): Promise<boolean> => {
    if (entry.ending.kind !== "idle" || deps.conversations.queued(entry.id).items.length > 0) {
        return false;
    }
    if (entry.identity.home === true) {
        return true;
    }
    const target = await landTargetOf(deps, entry);
    if (target.kind !== "main") {
        return false;
    }
    const span = entry.placement.repos.map(({ repo, base, landedTip }) => ({ repo, from: landedTip ?? base, dir: deps.agentWorktrees.worktreeDir(entry.id, repo) }));
    const decided = await decideLanding(deps, target, entry, undefined, span);
    return resolvesAtOnce(decided.mode === "check", entry, DRIFT_OPENING);
};

// Who hears of it, decided before anything is said, so the mark can say it was asked before the asking.
export type DriftTold = "parent" | "resolve" | "notice";

export const driftAudience = async (deps: DriftNewsDeps, entry: IsolatedAgent, askedBefore: boolean): Promise<DriftTold> => {
    const target = recordedTargetOf(deps.agents, entry);
    if (target.kind === "parent") {
        return !askedBefore && deps.conversations.running(target.parent) ? "parent" : "notice";
    }
    return !askedBefore && (await resolvesByItself(deps, entry)) ? "resolve" : "notice";
};

// The record's notice and the Activity row, both best-effort: a drift is still on the mark `agents show` reads.
const noted = async (deps: DriftNewsDeps, entry: IsolatedAgent, text: string, recorded: boolean): Promise<void> => {
    if (recorded && !deps.conversations.running(entry.id)) {
        await deps.transcripts.append({ id: entry.id }, [{ role: "notice", text }]).catch((error: Error) =>
            deps.logger.warn({ err: error, conversationId: entry.id }, "drift: the notice could not be written into the record"),
        );
    }
    await deps.activity
        .append({ direction: "system", type: "land.drifted", content: text, conversationId: entry.id })
        .catch((error: Error) => deps.logger.warn({ err: error, conversationId: entry.id }, "drift: the activity row could not be written"));
};

/** Says a drift to the audience chosen for it; answers whether the asking (a resolve turn, a parent's turn) went through. */
export const tellDrift = async (deps: DriftNewsDeps, entry: IsolatedAgent, repos: readonly DriftRepo[], told: DriftTold): Promise<boolean> => {
    const line = driftLine(deps, repos);
    const parent = recordedTargetOf(deps.agents, entry);
    if (told === "parent" && parent.kind === "parent") {
        const said = await sayToParent(deps, parent.parent, driftWords({ child: entry.id, title: titleOf(deps, entry.id) }, line));
        await noted(deps, entry, `${line} Its parent was told.`, true);
        return said;
    }
    if (told === "resolve") {
        const receipt = await deliverWake(deps, {
            conversationId: entry.id,
            prompt: driftPrompt(deps, repos),
            voice: "sandbox",
            errand: "land-conflict",
            source: "drift",
            profile: conversationProfile(entry),
        }).catch((error: Error) => {
            deps.logger.warn({ err: error, conversationId: entry.id }, "drift: the resolve turn could not be started");
            return undefined;
        });
        const started = receipt !== undefined && "delivered" in receipt;
        await noted(deps, entry, `${line} ${started ? "The agent was asked to resolve it now." : "Asking the agent to resolve it failed."}`, !started);
        return started;
    }
    await noted(deps, entry, `${line} Its land will need a resolve: message it to rebase now, or press Land and then Resolve.`, true);
    return false;
};
