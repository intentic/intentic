import { landedCommitMessage, type Rule } from "@intentic/sandbox-contract";
import { sleep } from "@intentic/base/async";
import type { Services } from "../../composition.js";
import { commitOnly } from "../../git/changes/changes-index.js";
import { committableSubject, commitSubjectFlaw, markSubjectBreaking } from "../../git/ops/commit-message.js";
import { AGENT_GIT_AUTHOR } from "../../git-identity.js";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import { standing } from "../../rules/rules.js";
import { reposOf } from "../registry/agents-store.js";
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
    const message = landedCommitMessage({
        ...(landed ?? { ...opt("testNote", trailers.testNote), ...opt("allows", trailers.allows === undefined ? undefined : [...trailers.allows]) }),
        subject,
    });
    const committed: string[] = [];
    for (const claim of claims) {
        const did = await services.agentWorktrees.withRepoLock(claim.repo, () => commitOnly(claim.dir, claim.paths, message, AGENT_GIT_AUTHOR));
        if (did) {
            committed.push(claim.repo);
        }
    }
    return committed;
};

// What happens to a landing once it is in the tree: the subject is drafted first, then, with the rule standing, the
// claim is committed under it. A draft that fails is already told on its report; it must not cost the commit, which
// falls back to the title. `unhold` is called the moment no commit is coming: at once when the rule does not stand,
// otherwise once the claim is committed (or failed to be).
export const settleLanding = async (services: Services, id: string, unhold: () => void = () => undefined): Promise<void> => {
    try {
        const { rules } = await services.sandboxSettings.get();
        const rule = versionRuleOf(rules);
        if (rule === undefined) {
            unhold();
        }
        await describeLanding(services, id).catch((error: unknown) => services.logger.debug({ err: error, agent: id }, "landed subject: draft failed"));
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

// The subject of the owner's own remainder, committed before an isolated turn reads the tree.
const REMAINDER_SUBJECT = "Your edits";

// Commits whatever is dirty in the main tree of each repo a turn is about to span, when the version rule stands;
// otherwise nothing, since an uncommitted tree is the developer's review boundary. Best-effort: a repo that refuses
// stays as it was and the turn goes on without the owner's latest edits, which is what happened before this existed.
export const versionMainTree = async (services: Services, repos: readonly string[]): Promise<string[]> => {
    const { rules } = await services.sandboxSettings.get();
    if (versionRuleOf(rules) === undefined) {
        return [];
    }
    const committed: string[] = [];
    for (const repo of repos) {
        try {
            const did = await services.agentWorktrees.withRepoLock(repo, () =>
                commitWorktreeRemainder(repo, services.agentWorktrees.mainDir(repo), REMAINDER_SUBJECT, services.agentWorktrees.mainDir("root")),
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
