import { errorMessage } from "@intentic/base/errors";
import type { LandedMessageDraft, LandedMessageStep } from "@intentic/sandbox-contract";
import { type RoleAnswer, sentenceReason } from "../../agent/models/role-answer.js";
import { askRoleModel, type RoleModelAttempt, roleModelIsSet } from "../../agent/models/role-model.js";
import type { Services } from "../../composition.js";
import {
    cleanBreakingNote,
    cleanCommitSubject,
    cleanReleaseNote,
    commitMessagePrompt,
    fallbackBreakingNote,
    markSubjectBreaking,
    type RepoDiff,
} from "../../git/ops/commit-message.js";
import { claimedContractShrink } from "../../git/changes/contract-shrink.js";
import { publishRuntimeChange } from "../../system/runtime-watch.js";

// The commit subject read off the code at land time, not the frozen session title (which describes the ask, not the
// change). Read through the same collectRepoDiff a real commit uses, so the two agree. Best-effort: nothing here may
// fail a land.

// Past this many repos the per-repo patch budget is too thin to say anything; caps one runaway land's prompt.
const MAX_REPOS = 12;

// One repo's still-claimed paths, described as the eventual commit would, plus what they'd remove from the wire
// contract. Undefined when nothing is claimed (nothing landed, or history already absorbed it).
const claimedDiff = async (services: Services, id: string, repo: string): Promise<{ diff: RepoDiff; removed: string[] } | undefined> => {
    const dir = services.agentWorktrees.mainDir(repo);
    const origins = await services.agentOrigins.forRepo(repo, dir);
    const paths = Object.entries(origins)
        .filter(([, ids]) => ids.includes(id))
        .map(([path]) => path);
    if (paths.length === 0) {
        return undefined;
    }
    // `paths`, not `all`: this is one agent's landed work in a tree that may hold others' too.
    return { diff: await services.git.collectRepoDiff(repo, dir, { paths }), removed: await claimedContractShrink(dir, paths) };
};

// Ceiling past which a reply is a runaway answer, not an overrun subject; refused replies route to the next model.
const SUBJECT_MAX_WORDS = 20;

// Everything one reply carries in one read: the subject plus its two optional trailers, so callers get one value
// instead of parsing the raw reply three times.
interface DraftedMessage {
    readonly subject: string;
    readonly note: string;
    readonly breaking: string;
}

// Subject decides if the reply was worth anything; the two trailers are optional (most commits earn neither), so their
// absence isn't a failure, but a missing subject is.
const messageAnswer = (wantsNote: boolean): RoleAnswer<DraftedMessage> => ({
    what: `a commit subject`,
    read: (reply) => ({
        subject: cleanCommitSubject(reply),
        note: wantsNote ? cleanReleaseNote(reply) : ``,
        breaking: cleanBreakingNote(reply),
    }),
    unusable: ({ subject }) => sentenceReason(`a commit subject`, subject, SUBJECT_MAX_WORDS),
});

// Sentence rides the changelog gate only when nothing was detected; a detected shrink always keeps one (the push gate
// reads it), falling back to a generated sentence if the model wrote none.
const breakingNote = (removed: readonly string[], written: string, wantsNote: boolean): string => {
    if (removed.length > 0) {
        return written === `` ? fallbackBreakingNote(removed) : written;
    }
    return wantsNote ? written : ``;
};

// One walk attempt restated in the report's own shape, the same fact.
const step = (attempt: RoleModelAttempt): LandedMessageStep => ({
    provider: attempt.choice.provider,
    model: attempt.choice.model,
    status: attempt.status,
    ...(attempt.at === undefined ? {} : { at: attempt.at }),
    ...(attempt.ms === undefined ? {} : { ms: attempt.ms }),
    ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
});

// No-op when there's nothing to say; never throws, since every caller is a land that already succeeded. Not awaited:
// the land's own response must not wait on a cheap-model call.
export const describeLanding = async (services: Services, id: string): Promise<void> => {
    const entry = services.agents.entry(id);
    if (entry === undefined) {
        return;
    }
    // Checked here, before a 'writing...' chip goes up, so an owner who disabled the model gets silence, not a failure.
    if (!(await roleModelIsSet(services, `commit-message`))) {
        return;
    }
    // Report opens with the diff itself as the started fact; later beats replace the whole report, never diff it.
    let draft: LandedMessageDraft = { startedAt: Date.now(), steps: [] };
    const publish = (next: LandedMessageDraft): void => {
        draft = next;
        services.agents.setLandedMessageDraft(id, draft);
    };
    const ended = (outcome: `written` | `failed`, reason?: string): void =>
        publish({ ...draft, outcome, ...(reason === undefined ? {} : { reason }), finishedAt: Date.now() });
    publish(draft);
    const claims = (await Promise.all(entry.repos.slice(0, MAX_REPOS).map((composed) => claimedDiff(services, id, composed.repo)))).filter(
        (claim) => claim !== undefined,
    );
    if (claims.length === 0) {
        // Nothing left to describe once history absorbed the claim; withdraw the report rather than leave noise.
        services.agents.setLandedMessageDraft(id, undefined);
        return;
    }
    const diffs = claims.map((claim) => claim.diff);
    // Non-empty is what forces a Breaking-Note rather than merely allowing one (commitMessagePrompt).
    const removed = claims.flatMap((claim) => claim.removed);
    // Asked for when any spanned repo keeps a changelog, the same 'any, not all' rule the commit box follows.
    const { changelogRepos } = await services.sandboxSettings.get();
    const wantsNote = diffs.some((diff) => changelogRepos.includes(diff.repo));
    // Diff only, no title: a title-plus-diff answer tends to write the title back verbatim, poisoning the commit.
    // Each walk beat publishes immediately; the outcome (`ended`) is written last, after the sentence is already live.
    try {
        const { value } = await services.perf.track("landing.subject", { agent: id, repos: diffs.length }, () =>
            askRoleModel(
                services,
                `commit-message`,
                { prompt: commitMessagePrompt(diffs, wantsNote, removed), answer: messageAnswer(wantsNote) },
                new AbortController().signal,
                { onProgress: (attempts) => publish({ ...draft, steps: attempts.map(step) }) },
            ),
        );
        // `!` is forced whenever a shrink was detected, not trusted from the model: release tooling majors on it.
        const subject = removed.length > 0 ? markSubjectBreaking(value.subject) : value.subject;
        // Usability is judged inside the ask now (messageAnswer); reaching this line already means a usable subject.
        const breaking = breakingNote(removed, value.breaking, wantsNote);
        // Broadcasts synchronously, so an already-open panel's chip updates with no separate request.
        await services.agents.setLandedSubject(id, {
            subject,
            ...(value.note === `` ? {} : { note: value.note }),
            ...(breaking === `` ? {} : { breaking }),
        });
        // Sentence lands on the card before the report says so (ordering note above).
        ended(`written`);
        // For an archived agent, whose card is off the roster: nothing else would refresh its review chip.
        publishRuntimeChange("landings");
    } catch (error) {
        // Chain ran dry, or nothing was connected; steps carry each model's words, this is for a one-line surface.
        ended(`failed`, errorMessage(error));
        throw error;
    }
};

// Fire-and-forget: a failure here is a log line, never the land's problem.
export const describeLandingInBackground = (services: Services, id: string): void => {
    void describeLanding(services, id).catch((error: unknown) => services.logger.debug({ err: error, agent: id }, "landed subject: draft failed"));
};
