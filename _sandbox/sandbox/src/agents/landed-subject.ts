import { isDeclinedAnswer, isFailureSentence } from "../agent/failure-sentences.js";
import { askQuickModel } from "../agent/quick-model.js";
import type { Services } from "../composition.js";
import { cleanBreakingNote, cleanCommitSubject, cleanReleaseNote, commitMessagePrompt, fallbackBreakingNote, markSubjectBreaking, type RepoDiff } from "../git/commit-message.js";
import { claimedContractShrink } from "../git/contract-shrink.js";
import { publishRuntimeChange } from "../system/runtime-watch.js";

/* WHAT THE WORK DID, WRITTEN WHEN IT ARRIVES — the sentence the Changes panel's "From" chip files into the
 * commit box.
 *
 * The chip used to file the session's TITLE, read as a subject. A title is written once, from the opening
 * prompt, a second into the first turn, and then frozen for the life of the conversation (agent/title-namer.ts
 * and the source ranking it answers to). That is right for a name — you go looking for the session you
 * remember — and wrong for a commit subject, because the two describe different things. A conversation that
 * opens "audit the review panel", finds three problems and fixes them still answers to `Review panel · audit`,
 * so the commit went in claiming to be an audit. The drift is not a bug in the naming; the ask and the change
 * are simply not the same fact, and only one of them is in the diff.
 *
 * SO IT IS READ OFF THE CODE, and read at the one moment that costs nobody anything: the land. The diff is
 * already in the tree, the user is not waiting on anything, and the answer is on the entry long before the
 * panel is opened — which is what keeps the chip's click free and instant. Drafting it on the click instead
 * would put a model call behind a gesture that also just filters the list, and every browse of the legend
 * would spend quota.
 *
 * THE SAME READING THE COMMIT WILL MAKE. The diff comes from the paths this agent CLAIMS in the main tree
 * (agents/origins.ts) through collectRepoDiff, the same reader a commit's own diff goes through — so the sentence describes
 * exactly the set of files the chip narrows to and the commit records, and the two ways of naming a commit
 * cannot come back in different styles. It is the claim rather than the patch just applied, which is what
 * makes a second land describe the WHOLE outstanding claim: the user commits what the chip shows, not what
 * one land contributed to it.
 *
 * BEST EFFORT, ALWAYS. No quick model connected, a provider that refuses, an empty reply — every one of them
 * leaves the entry as it was, and the panel falls back to reading the title as a subject, which is where this
 * started. Nothing here may fail a land: the work is in the tree either way, and a sentence about it is not
 * worth a red card. */

// A landing spanning more repos than this is a composition-wide sweep, and the per-repo patch budget in the
// prompt is already split across them — past a point each repo contributes too little to say anything with.
// The cap keeps one runaway land from building a prompt out of fifty stat blocks.
const MAX_REPOS = 12;

// One repo's contribution: the paths this agent still claims there, described exactly as the commit that
// records them would be, plus what those paths would REMOVE from the wire contract (git/contract-shrink.ts —
// read here, beside the diff, so the two describe the same claim). Undefined when it claims nothing — the
// land put nothing here, or history has already absorbed all of it.
const claimedDiff = async (services: Services, id: string, repo: string): Promise<{ diff: RepoDiff; removed: string[] } | undefined> => {
    const dir = services.agentWorktrees.mainDir(repo);
    const origins = await services.agentOrigins.forRepo(repo, dir);
    const paths = Object.entries(origins)
        .filter(([, ids]) => ids.includes(id))
        .map(([path]) => path);
    if (paths.length === 0) {
        return undefined;
    }
    // `paths`, never `all`: this describes ONE agent's landed work sitting in a tree that may hold several
    // agents' — and the user's own edits besides.
    return { diff: await services.git.collectRepoDiff(repo, dir, { paths }), removed: await claimedContractShrink(dir, paths) };
};

/* Draft and store the subject for what this agent has landed. Resolves without effect whenever there is
 * nothing to say; never throws — every caller is a land that has already succeeded.
 *
 * Not awaited by its callers, on purpose: this is a model call on the cheap rung, and the land's own response
 * (the frame, the card's new state, the panel's refresh) must not wait a second for a sentence nothing on
 * screen is showing yet. */
export const describeLanding = async (services: Services, id: string): Promise<void> => {
    const entry = services.agents.entry(id);
    if (entry === undefined) {
        return;
    }
    const claims = (await Promise.all(entry.repos.slice(0, MAX_REPOS).map((composed) => claimedDiff(services, id, composed.repo)))).filter(
        (claim) => claim !== undefined,
    );
    if (claims.length === 0) {
        return;
    }
    const diffs = claims.map((claim) => claim.diff);
    // What this landing removes from the wire contract, across every repo it spans. Non-empty is what flips
    // the draft from "consider a Breaking-Note" to "carry one" — see the forced block in commitMessagePrompt.
    const removed = claims.flatMap((claim) => claim.removed);
    /* A note is asked for when any repo this landing touched keeps a changelog — the same "any, not all" rule
     * the commit box's own draft follows (git.routes.ts), and for the same reason: one message covers every
     * repo the commit spans, so it is written for the audience that has one. */
    const { changelogRepos } = await services.sandboxSettings.get();
    const wantsNote = diffs.some((diff) => changelogRepos.includes(diff.repo));
    /* THE DIFF AND NOTHING ELSE. This call used to hand the session's title over beside the patch as context
     * about what the work was FOR. It reliably came back as the answer instead of as context: the cheap rung
     * given a title and a diff writes the title back, so a conversation named for the question that opened it
     * committed under that question no matter what the four turns since had done. Worse, the title is itself
     * model-written — a naming pass that failed and asked for more context put that request into the commit
     * message. What the change was for is legible in what it did, and the diff cannot go stale. */
    /* SAY THAT IT IS BEING WRITTEN, before the call rather than after it. The sentence is the one thing about a
     * landing that arrives LATE, so the seconds it takes are the only part of this feature a user ever
     * experiences as a wait — and until this flag they waited at a chip that looked exactly like one with
     * nothing behind it. Broadcast on the roster rather than published as a review change, because it is a fact
     * about the AGENT and the roster frame is already live: routing it through `landings` would spend a
     * workspace-wide rescan to deliver one boolean (see the publish at the end, which spends one deliberately).
     *
     * The `finally` is the whole of the cleanup: every road out of the model call — an answer, a refusal, the
     * chain running dry, a throw — has to clear it, or a chip keeps saying "writing…" about a call that ended
     * minutes ago. */
    await services.agents.setDraftingSubject(id, true);
    const { text } = await services.perf
        .track("landing.subject", { agent: id, repos: diffs.length }, () =>
            askQuickModel(services, commitMessagePrompt(diffs, wantsNote, removed), new AbortController().signal),
        )
        .finally(() => services.agents.setDraftingSubject(id, false));
    // The `!` is enforced rather than trusted whenever the detector saw a shrink: the marker is what the
    // release tooling majors on, and a model that dropped it would ship the removal as a minor bump.
    const drafted = cleanCommitSubject(text);
    const subject = removed.length > 0 ? markSubjectBreaking(drafted) : drafted;
    // A provider's refusal arrives as this reply's TEXT on the providers whose failures stream as prose, so it
    // is checked here rather than left to the throw above — and a model that asked a question back instead of
    // describing the diff has not written a subject either. The same pair of guards, for the same reasons, as
    // the naming pass makes over its own reply (agent/title-namer.ts).
    if (subject === `` || isFailureSentence(subject) || isDeclinedAnswer(subject)) {
        return;
    }
    /* The note is read from the same reply, and only kept when one was asked for: a model that volunteers a
     * trailer on a repo that keeps no changelog has answered a question nobody put to it. The breaking
     * sentence rides the same gate ONLY while nothing was detected — a detected shrink keeps its sentence on
     * every repo, changelog or not, because the declaration is what the push gate reads from the range
     * (COMPATIBILITY.md), and it falls back to the truthful floor when the model wrote none.
     *
     * These two and the subject are now the WHOLE of a drafted message. The body that used to sit between them
     * is gone (git/commit-message.ts says why it is not read back): a subject naming what changed, and — for a
     * repo that publishes one — a sentence for the people who will read the release, is everything the box
     * needs to be filled with. */
    const note = wantsNote ? cleanReleaseNote(text) : ``;
    const written = cleanBreakingNote(text);
    const breaking = removed.length > 0 ? (written === `` ? fallbackBreakingNote(removed) : written) : wantsNote ? written : ``;
    await services.agents.setLandedSubject(id, {
        subject,
        ...(note === `` ? {} : { note }),
        ...(breaking === `` ? {} : { breaking }),
    });
    /* AND SAY SO, which is the difference between a sentence that is written and one that is read.
     *
     * Everything above happens SECONDS after the land — the model call is the whole delay — and the review panel
     * refreshed the moment the turn ended, which is before this began. Nothing else was coming: the entry is on
     * /history so no workspace path names it, and writing a sentence moves no ref. So the panel held a snapshot
     * taken just before the message existed, and a "From" chip clicked in that window filed nothing into the
     * commit box — for as long as it took some unrelated write to refresh the review by accident.
     *
     * Published rather than broadcast on the roster: the chip reads this through the review (agents/origins.ts),
     * because a landing outlives the card that made it, so it is the review that has to be re-asked. */
    publishRuntimeChange("landings");
};

// The fire-and-forget form every land site uses: a failure here is a log line, never the land's problem.
export const describeLandingInBackground = (services: Services, id: string): void => {
    void describeLanding(services, id).catch((error: unknown) => services.logger.debug({ err: error, agent: id }, "landed subject: draft failed"));
};
