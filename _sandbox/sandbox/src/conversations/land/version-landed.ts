import { landedCommitMessage } from "@intentic/sandbox-contract/state/landed-commit";
import type { Rule } from "@intentic/sandbox-contract/schemas/settings";
import { sleep } from "@intentic/base/async";
import type { Services } from "../../composition.js";
import { AgentDomainRefusedError } from "../../workload/agent-execution.js";
import { commitOnly } from "../../git/changes/changes-index.js";
import { committableSubject, commitSubjectFlaw, markSubjectBreaking } from "../../git/ops/commit-message.js";
import { AGENT_GIT_AUTHOR, withConversationTrailer } from "../../git-identity.js";
import { isProjectFolderRepo } from "../../git/remote/project-repo.js";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import { standing } from "../../rules/rules.js";
import { reposOf } from "../registry/agents-store.js";
import { landMarksOf } from "../registry/land-marks.js";
import { conversationTrailers, describeLanding } from "./landed-subject.js";
import { opt } from "../../opt.js";

// The `version-landed` built-in at `agent.landed`: keeps the main tree committed for a person who never commits.
// Worktrees are cut from HEAD (worktrees.ts `snapshot`) and the pre-turn sync rebases onto HEAD, so a land left
// uncommitted is invisible to every later agent. Two moments close that: right after a land, its claimed paths are
// committed under the subject drafted for it; right before an isolated turn starts, whatever else is dirty in the
// main tree (the owner's own edits) is committed too, so the assistant reads what its owner wrote.

const VERSION_BUILTIN = "version-landed";

// The standing rule, if the owner has one; a disabled or absent rule leaves every commit to the owner.
export const versionRuleOf = (rules: readonly Rule[]): Rule | undefined =>
    standing(rules, "agent.landed").find((rule) => rule.action.kind === "builtin" && rule.action.name === VERSION_BUILTIN);

// The subject an owner would read in `git log` when the drafting model wrote nothing (disabled, refused, or the land
// left nothing to describe): the conversation's own title, which at least names the ask.
const fallbackSubject = (title: string | undefined, id: string): string => `Agent: ${title ?? id}`;

// One repo's claim: the paths this agent's landing put in its main tree that history has not absorbed yet.
interface RepoClaim {
    readonly repo: string;
    readonly dir: string;
    readonly paths: readonly string[];
}

// The claim is read off git (origins.ts), which is exactly the set a commit should carry.
const claimsOf = async (services: Services, id: string, repos: readonly string[]): Promise<RepoClaim[]> => {
    const claims: RepoClaim[] = [];
    for (const repo of repos) {
        const dir = services.agentWorktrees.mainDir(repo);
        const origins = await services.agentOrigins.forRepo(repo, dir);
        const paths = Object.entries(origins)
            .filter(([, ids]) => ids.includes(id))
            .map(([path]) => path);
        if (paths.length > 0) {
            claims.push({ repo, dir, paths });
        }
    }
    return claims;
};

// Commits one landing's claimed paths in each repo it spans, under the repo lock so a land or a discard queues behind
// it. Returns the repos it committed in. Every land reaches the main tree's history here (a turn's, one by hand, a
// conflict's re-land, a fix-up's), so this is where its subject is judged: whichever path drafted or stored it.
const commitClaim = async (services: Services, id: string): Promise<string[]> => {
    const entry = services.agents.entry(id);
    if (entry === undefined) {
        return [];
    }
    const claims = await claimsOf(
        services,
        id,
        reposOf(entry).map((composed) => composed.repo),
    );
    if (claims.length === 0) {
        return [];
    }
    // The drafted message with its trailers; a land nobody drafted keeps the conversation's Test-Note and Allow lines all
    // the same.
    const landed = entry.landing.message;
    const trailers = landed === undefined ? await conversationTrailers(services, entry) : {};
    const title = entry.social.title?.text;
    // The title stands in only when it could head a commit itself; the prefix would hide a narrated one from the check.
    const written = landed?.subject ?? (title === undefined || commitSubjectFlaw(title) === undefined ? fallbackSubject(title, id) : ``);
    const built = committableSubject(written, claims.flatMap((claim) => claim.paths));
    // A replaced subject still carries the `!` its Breaking-Note trailer needs: release tooling majors on the marker.
    const subject = built !== written && landed?.breaking !== undefined ? markSubjectBreaking(built) : built;
    if (subject !== written) {
        services.logger.warn({ agent: id, refused: written, subject }, "landed: its subject could not head a commit, committed under one built from the change");
    }
    // Trailed with the conversation like its branch commits: this commit is one conversation's land, and every land has
    // the same author, so the trailer is the only way `git log` on main says which conversation it came from. It joins
    // the Test-Note/Allow paragraph rather than following it, and passes commitlint as an ordinary footer.
    const message = withConversationTrailer(
        landedCommitMessage({
            ...(landed ?? { ...opt("testNote", trailers.testNote), ...opt("allows", trailers.allows === undefined ? undefined : [...trailers.allows]) }),
            subject,
        }),
        id,
    );
    const committed: string[] = [];
    for (const claim of claims) {
        const did = await services.agentWorktrees.withRepoLock(claim.repo, () => commitOnly(claim.dir, claim.paths, message, AGENT_GIT_AUTHOR));
        if (did) {
            committed.push(claim.repo);
        }
    }
    return committed;
};

// The land's version-pending mark (registry/land-marks.ts) answered: the settle that ran for it is over, however it
// ended. Only the mark this settle began under: a newer land's is its own settle's to clear. A write that fails leaves
// the mark, and the next boot settles that land once more, which finds nothing left to commit when this one made it.
const answerVersionMark = async (services: Pick<Services, "agents" | "logger">, id: string, since: number | undefined): Promise<void> => {
    if (since === undefined) {
        return;
    }
    try {
        await services.agents.amendLandMarks(id, (marks) => (marks.versionPending === since ? { ...marks, versionPending: undefined } : marks));
    } catch (error) {
        services.logger.warn({ err: error, agent: id }, "landed: its version-pending mark could not be cleared, the next boot settles it again");
    }
};

// What happens to a landing once it is in the tree: the subject is drafted first, then, with the rule standing, the
// claim is committed under it. An ordinary draft failure is already told on its report and falls back to the title;
// an execution-domain refusal is not permission to continue. `unhold` is called the moment no commit is coming: at once when the rule does not stand,
// otherwise once the claim is committed (or failed to be). The land's version-pending mark is cleared as it ends, so only
// a daemon that died meanwhile leaves it for the boot (settlePendingVersions).
export const settleLanding = async (services: Services, id: string, unhold: () => void = () => undefined): Promise<void> => {
    const since = landMarksOf(services.agents.entry(id)).versionPending;
    try {
        const { rules } = await services.sandboxSettings.get();
        const rule = versionRuleOf(rules);
        if (rule === undefined) {
            unhold();
        }
        await describeLanding(services, id).catch((error: unknown) => {
            if (error instanceof AgentDomainRefusedError) { throw error; }
            services.logger.debug({ err: error, agent: id }, "landed subject: draft failed");
        });
        if (rule === undefined) {
            return;
        }
        const committed = await commitClaim(services, id);
        if (committed.length === 0) {
            return;
        }
        // The commit itself moves HEAD, which the daemon's ref watcher already announces to every panel; only the firing
        // needs recording here.
        services.ruleFirings.stamp(rule.id, Date.now()).catch((error: unknown) => services.logger.warn({ err: error }, "rule firing stamp failed"));
        services.logger.info({ agent: id, repos: committed }, "landed: versioned");
    } finally {
        await answerVersionMark(services, id, since);
        unhold();
    }
};

// Lands whose version commit is still to come, per main checkout, from the moment the land reached the tree. Until that
// commit, the landed paths are uncommitted edits in the main tree like any of the owner's, so a second land judged in
// that window would read another agent's work as the owner's and be refused on it: a card asking the owner to commit
// edits the version commit takes a moment later, and a rebase that never saw the work it has to merge with.
const versioning = new Map<string, Set<Promise<void>>>();

// Longest a land waits on another's version commit. The subject is drafted by a model first, and one that hangs must
// not hold every later land in the repo; past this the land judges the tree as it stands, as it always did.
export const VERSION_WAIT_MS = 60_000;

// Holds each named main checkout until `until` settles.
const holdVersioning = (dirs: readonly string[], until: Promise<void>): void => {
    for (const dir of dirs) {
        const held = versioning.get(dir) ?? new Set<Promise<void>>();
        held.add(until);
        versioning.set(dir, held);
    }
    void until.finally(() => {
        for (const dir of dirs) {
            const held = versioning.get(dir);
            held?.delete(until);
            if (held?.size === 0) {
                versioning.delete(dir);
            }
        }
    });
};

// Resolves once no land into these repos is waiting on its version commit, or after `capMs`; never rejects. Awaited
// before a land's pre-land rebase, so the branch is rebased onto the commit and the land judged against it.
export const versionCommitsSettled = async (
    services: Pick<Services, "agentWorktrees">,
    repos: readonly string[],
    capMs: number = VERSION_WAIT_MS,
): Promise<void> => {
    if (versioning.size === 0) {
        return;
    }
    const pending = repos.flatMap((repo) => [...(versioning.get(services.agentWorktrees.mainDir(repo)) ?? [])]);
    if (pending.length === 0) {
        return;
    }
    const cap = new AbortController();
    await Promise.race([Promise.allSettled(pending), sleep(capMs, { signal: cap.signal, unref: true })]);
    cap.abort();
};

// Never throws and never awaited on a land's own response: a land that already succeeded must not fail on its
// bookkeeping. Holds the repos it landed in synchronously, before anything else can land into them.
export const settleLandingInBackground = (services: Services, id: string): void => {
    const entry = services.agents.entry(id);
    const { promise: settled, resolve: unhold } = Promise.withResolvers<void>();
    if (entry !== undefined) {
        holdVersioning(
            reposOf(entry).map((composed) => services.agentWorktrees.mainDir(composed.repo)),
            settled,
        );
    }
    void settleLanding(services, id, unhold).catch((error: unknown) => services.logger.warn({ err: error, agent: id }, "landed: settling failed"));
};

// THE VERSION COMMITS A RESTART CUT. A land's version commit runs off the land's own clock (the subject is drafted by a
// model first), so a daemon that died between the land and that commit left the landed paths uncommitted in the main
// tree, and the next isolated turn took them into the owner's remainder ("Your edits") with no conversation trailer.
// Every land into the main tree marks its record as owing the commit (registry/land-marks.ts); the boot settles each
// marked one again, holding its repos from that moment as a fresh land does, so a land or a turn opening there waits for
// its commit (versionCommitsSettled), and the remainder leaves its paths alone until then (versionMainTree). A boot step
// (bootstrap/boot-chain.ts), so it holds before the gate opens and before anything can start or resume a turn. Answers the
// conversations it settles.
export const settlePendingVersions = (services: Services): string[] => {
    const owed = services.agents.ids().filter((id) => landMarksOf(services.agents.entry(id)).versionPending !== undefined);
    for (const id of owed) {
        settleLandingInBackground(services, id);
    }
    if (owed.length > 0) {
        services.logger.info({ agents: owed }, "landed: version commits a restart cut are being made now");
    }
    return owed;
};

// Each repo's paths that lands still owing their version commit claim: left out of the remainder, or it would take
// another conversation's work under the owner's subject and lose the trailer that names it.
const pendingClaims = async (services: Services, repos: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> => {
    const left = new Map<string, string[]>();
    for (const id of services.agents.ids()) {
        const entry = services.agents.entry(id);
        if (entry === undefined || landMarksOf(entry).versionPending === undefined) {
            continue;
        }
        const spanned = reposOf(entry).flatMap(({ repo }) => (repos.includes(repo) ? [repo] : []));
        for (const claim of await claimsOf(services, id, spanned)) {
            left.set(claim.repo, [...(left.get(claim.repo) ?? []), ...claim.paths]);
        }
    }
    return left;
};

// The subject of the owner's own remainder, committed before an isolated turn reads the tree.
const REMAINDER_SUBJECT = "Your edits";

// A project folder's remainder: what file sync delivered since the last boundary, and any land not committed since.
const folderSubject = (repo: string): string => `Your ${repo} folder as it stands`;

type VersionDeps = Pick<Services, "agentWorktrees" | "logger">;

// Each repo's main-tree remainder committed under the repo's lock; answers the repos that took a commit. Best-effort per
// repo: one that refuses stays as it was and is said in the log.
const commitRemainders = async (
    services: VersionDeps,
    repos: readonly string[],
    subjectOf: (repo: string) => string,
    left: ReadonlyMap<string, readonly string[]> = new Map(),
): Promise<string[]> => {
    const committed: string[] = [];
    for (const repo of repos) {
        try {
            const did = await services.agentWorktrees.withRepoLock(repo, () =>
                commitWorktreeRemainder(
                    repo,
                    services.agentWorktrees.mainDir(repo),
                    subjectOf(repo),
                    services.agentWorktrees.mainDir("root"),
                    undefined,
                    left.get(repo) ?? [],
                ),
            );
            if (did) {
                committed.push(repo);
            }
        } catch (error) {
            services.logger.warn({ err: error, repo }, "version: committing the main tree's remainder failed");
        }
    }
    return committed;
};

// Which of these repos are project folders' mirrors (git/remote/project-repo.ts). A repo that cannot be asked is left
// out, as one the version rule does not reach is.
const projectFolders = async (services: VersionDeps, repos: readonly string[]): Promise<string[]> => {
    const marked = await Promise.all(
        repos.map(async (repo) => {
            try {
                return (await isProjectFolderRepo(services.agentWorktrees.mainDir(repo))) ? [repo] : [];
            } catch (error) {
                services.logger.warn({ err: error, repo }, "version: could not tell whether a repo is a project folder");
                return [];
            }
        }),
    );
    return marked.flat();
};

// A PROJECT FOLDER IS VERSIONED WHATEVER THE RULE SAYS. Its repo is a mirror of a folder file sync fills, never anyone's
// review boundary: nothing committed there reaches the owner (the git bridge refuses a project pairing), and their own
// edits arrive in it uncommitted by construction. Left uncommitted, a checkout cut from its HEAD reads the folder as it
// was at the first boot, and every land is judged against edits that read as the owner's work in progress, so it is
// refused on any file both touched. Committed at each boundary instead, a land is judged against what the folder holds,
// and a file both touched is a merge rather than a wall.
export const versionProjectFolders = async (services: VersionDeps, repos: readonly string[]): Promise<string[]> =>
    commitRemainders(services, await projectFolders(services, repos), folderSubject);

// Commits whatever is dirty in the main tree of each repo a turn is about to span, when the version rule stands;
// otherwise only the project folders' (above), since an uncommitted tree is the developer's review boundary.
// Best-effort: a repo that refuses stays as it was and the turn goes on without the owner's latest edits, which is
// what happened before this existed. A land's version commit still to come is waited for first, as a land waits for it,
// so the turn reads that work as its own commit; one that outlasts the wait keeps its paths out of the remainder.
export const versionMainTree = async (services: Services, repos: readonly string[]): Promise<string[]> => {
    await versionCommitsSettled(services, repos);
    const { rules } = await services.sandboxSettings.get();
    const folders = await projectFolders(services, repos);
    const left = await pendingClaims(services, repos);
    if (versionRuleOf(rules) === undefined) {
        return commitRemainders(services, folders, folderSubject, left);
    }
    return commitRemainders(services, repos, (repo) => (folders.includes(repo) ? folderSubject(repo) : REMAINDER_SUBJECT), left);
};
