// A conversation's id is the most public string this app produces: the git branch, the worktree directory, the URL, and
// the card title. `word-tail` reads at a glance; the tail keeps it unique and must satisfy
// ConversationIdSchema. Sandbox-started conversations use their own prefixed, derived ids instead.

import { CONVERSATION_WORDS } from "./conversation-words.js";

// The injection guard every path that interpolates a conversation id relies on: is this safe to put in a path.
export const CONVERSATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// Safe to interpolate into a path or a branch name. `false` for anything else, including the empty string.
export const isConversationId = (value: string): boolean => CONVERSATION_ID.test(value);

// The longest title a conversation opens with (AgentTurn.title). A title made by joining words (a fresh session's
// "Code review: " and its origin's whole title) runs past it easily, and a turn naming one is refused outright, so a
// sender clips it first rather than lose the turn to its name.
export const CONVERSATION_TITLE_MAX = 80;
export const clipTitle = (title: string): string =>
    title.length <= CONVERSATION_TITLE_MAX ? title : `${title.slice(0, CONVERSATION_TITLE_MAX - 1).trimEnd()}…`;

// One word and a tail: `otter-k7mq`, about ten characters, since every letter counts on the board's rows. The word is
// what a person reads and says; the tail is what keeps it unique.
//
// The tail is lowercase on purpose. The id is also the branch and the worktree directory, and both reach Windows and
// macOS filesystems that fold case, where `otter-K7mq` and `otter-k7mq` would be one folder. So the tail's alphabet is
// base36 with the characters people misread dropped (0/o, 1/l/i): 31 symbols, four of them 923,521 values per word,
// and with the word list about 2^29 ids in all, far past any workspace's collision risk.
export const TAIL_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const TAIL_LENGTH = 4;

// Rejects the short remainder above the last full bucket rather than folding it back with `%`, which would bias the
// first few results, exactly what a CSPRNG must avoid.
const UINT32_RANGE = 0x1_0000_0000;
const randomBelow = (upperBound: number): number => {
    const bucketSize = Math.floor(UINT32_RANGE / upperBound);
    const limit = bucketSize * upperBound;
    while (true) {
        const value = crypto.getRandomValues(new Uint32Array(1))[0]!;
        if (value < limit) {
            return Math.floor(value / bucketSize);
        }
    }
};

// Draws uniformly via the platform CSPRNG, not `Math.random()` (seeded per process): two tabs opened at once must not
// get the same name.
const pick = <T>(values: readonly T[]): T => values[randomBelow(values.length)]!;

// One TAIL_ALPHABET character per draw, all of which the id guard accepts.
const TAIL_SYMBOLS = [...TAIL_ALPHABET];
const tail = (): string => Array.from({ length: TAIL_LENGTH }, () => pick(TAIL_SYMBOLS)).join("");

// A fresh id: `<word>-<tail>`, e.g. `otter-k7mq`; about ten characters against a UUID's thirty-six.
export const newConversationId = (): string => `${pick(CONVERSATION_WORDS)}-${tail()}`;

// A DRAWN ID WORN UNDER A PREFIX. Three kinds of conversation draw an id like any other and say what they are in front
// of it: a spawned subagent (`sub-otter-k7mq`), a conversation a link opened here (`link-…`) and the roster entry for a
// task running on a linked sandbox (`linked-…`). Kept here beside the word list, since no word may read as one of them.
export const SUBAGENT_PREFIX = "sub-";
export const LINK_CONVERSATION_PREFIX = "link-";
export const LINKED_PREFIX = "linked-";
const WRAPPING_PREFIXES = [SUBAGENT_PREFIX, LINK_CONVERSATION_PREFIX, LINKED_PREFIX];
const unwrapped = (id: string): string => {
    const prefix = WRAPPING_PREFIXES.find((candidate) => id.startsWith(candidate));
    return prefix === undefined ? id : id.slice(prefix.length);
};

// Whether an id is shaped like one `newConversationId` draws, or like the `adjective-noun-xxxx` ids it drew before,
// bare or under one of the prefixes above. For telling an instance apart from a route (perf rollups), not a guard: a
// derived id can still look like one.
const WORDS = new Set(CONVERSATION_WORDS);
const DRAWN_ID = new RegExp(`^([a-z]+)-[${TAIL_ALPHABET}]{${TAIL_LENGTH}}$`);
const LEGACY_DRAWN_ID = /^[a-z]+-[a-z]+-[a-z0-9]{4}$/;
export const looksDrawn = (id: string): boolean => {
    const drawn = unwrapped(id);
    return WORDS.has(DRAWN_ID.exec(drawn)?.[1] ?? "") || LEGACY_DRAWN_ID.test(drawn);
};

// Derived, not drawn, so a re-computed id says whether an agent is already on this failure and a second press continues
// it. The repo is included (one run id per project) and slugified, not hashed, since people read it. Kept short, since it
// is also the branch and the worktree folder every board row prints: `fix-intentic-jqzy27q`, not
// `ci-fix-intentic-42991360694`. Not `ci-`: the gate CLI names its own conversations `ci-<run>-<attempt>`. The run id is base36 (the widest either forge mints, eleven digits, is eight
// characters), and the repo is cut at sixteen, which still names it: the run id is what keeps two repos apart.
export const CI_FIX_PREFIX = "fix-";
// What fix agents minted before the ids were shortened carry; still a fix agent's, so still read as one.
const LEGACY_CI_FIX_PREFIX = "ci-fix-";
export const isCiFixConversationId = (id: string): boolean => id.startsWith(CI_FIX_PREFIX) || id.startsWith(LEGACY_CI_FIX_PREFIX);
const REPO_SLUG_MAX = 16;
const repoSlug = (repo: string, max = REPO_SLUG_MAX): string =>
    repo
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, max)
        .replace(/^-+|-+$/g, "") || "repo";
export const ciFixConversationId = (repo: string, runId: number): string => `${CI_FIX_PREFIX}${repoSlug(repo)}-${runId.toString(36)}`;
// The same failure's id as it was minted before 2026-11-12: the repo cut at thirty-two, the run id in decimal. Fix agents
// started then still answer their failures, so every reader that pairs a run with its agent asks under both (ciFixBase).
const LEGACY_REPO_SLUG_MAX = 32;
export const legacyCiFixConversationId = (repo: string, runId: number): string =>
    `${LEGACY_CI_FIX_PREFIX}${repoSlug(repo, LEGACY_REPO_SLUG_MAX)}-${runId}`;
// The base a run's fix attempts share: the legacy spelling while an attempt under it is known (live or archived), so a
// press on a failure fixed before the ids were shortened continues that family (attempt 3, not a second attempt 1 that
// knows nothing of the first two); the current spelling otherwise.
export const ciFixBase = (repo: string, runId: number, knownIds: Iterable<string>): string => {
    const legacy = legacyCiFixConversationId(repo, runId);
    for (const id of knownIds) {
        if (fixAttemptOf(legacy, id) !== undefined) {
            return legacy;
        }
    }
    return ciFixConversationId(repo, runId);
};
// The title a CI fix conversation opens with: the daemon names it so (ci-fix.ts), and the board's card standing in for it
// while the press is out (Pipelines, `chat.launchAgent`) wears the same words, so the one hands over to the other unchanged.
export const ciFixTitle = (run: { readonly title?: string | undefined; readonly repo: string }): string =>
    `Fix CI: ${run.title ?? run.repo}`.slice(0, CONVERSATION_TITLE_MAX);

// FNV-1a, not a cryptographic hash: nothing here is secret, the only requirement is the same failure yields the same
// seven characters in every browser and in node. The one spelling: what a failing main owes is named by it too (a
// failed job's id, ci/main-fixer.ts).
const FNV_OFFSET = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;
export const fnvDigest = (text: string): string => {
    let hash = FNV_OFFSET;
    for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME);
    }
    return (hash >>> 0).toString(36).padStart(7, "0");
};

// A PERSON'S HOME CONVERSATION in one sandbox: the one long-running chat the master view opens on it, one per member,
// so two people with the same sandbox connected never share it. Derived from the email rather than drawn, so every
// browser and the daemon name the same conversation without asking, and an email never sits in an id other members read
// on the board. Two independent FNV digests (64 bits between them): a sandbox's members never come near a collision.
// The daemon is the one that says which id is whose (`GET /agents/home`); a client computing it is only a shortcut.
export const HOME_PREFIX = "home-";
const homeKey = (email: string): string => email.trim().toLowerCase();
export const homeConversationId = (email: string): string => `${HOME_PREFIX}${fnvDigest(homeKey(email))}${fnvDigest(`home:${homeKey(email)}`)}`;
// Whether an id is shaped like somebody's home conversation; whose it is takes the email (`homeConversationId`).
export const isHomeConversationId = (id: string): boolean => id.startsWith(HOME_PREFIX);

// A failing main-line check that no conversation still holding the work could take: keyed by the project and the moment
// it began failing, so every attempt at one streak shares a base and a later streak in the same project starts over.
// Seconds in base36 keep it short; the workspace root is spelled `workspace`, since its project folder is empty.
export const LAND_FIX_PREFIX = "land-fix-";
export const landFixConversationId = (project: string, failingSince: number): string =>
    `${LAND_FIX_PREFIX}${repoSlug(project === "" ? "workspace" : project)}-${Math.floor(failingSince / 1000).toString(36)}`;

// ONE FAILURE, MANY ATTEMPTS, ONE LIVE ANSWER. The derived id above names the FAILURE; an attempt at it is a
// conversation of its own, so starting over (another model, a clean worktree) never rewrites a record some other window
// is showing, and every attempt keeps its own transcript, cost and URL. Attempt 1 wears the bare id, so every id minted
// before attempts existed is attempt 1 of its failure. Later ones add `_<n>`: an underscore, since no base holds one (a
// slug turns every other character into `-`), so `fix-web-15_2` can only be run 15's second attempt, never a base.
const ATTEMPT_MARK = "_";
// What later attempts carried before 2026-11-12, still read on the bases minted then (a legacy CI fix's, which ends in a
// decimal run id, and a land fix's, which ends in six base36 characters), where `-attempt` cannot be part of a base.
// Never on a current `fix-` base: its base36 run id could one day spell it.
const LEGACY_ATTEMPT_MARK = "-attempt";
const legacyAttempts = (base: string): boolean => base.startsWith(LEGACY_CI_FIX_PREFIX) || base.startsWith(LAND_FIX_PREFIX);

export const fixAttemptId = (base: string, attempt: number): string => (attempt <= 1 ? base : `${base}${ATTEMPT_MARK}${attempt}`);

// Which attempt at `base` this id is, or undefined for an id that is none of them. Read base-relative, never the other
// way round: the marker is unambiguous, but only the base says which failure an attempt answers.
export const fixAttemptOf = (base: string, id: string): number | undefined => {
    if (id === base) {
        return 1;
    }
    const mark = [ATTEMPT_MARK, ...(legacyAttempts(base) ? [LEGACY_ATTEMPT_MARK] : [])].find((each) => id.startsWith(`${base}${each}`));
    if (mark === undefined) {
        return undefined;
    }
    const rest = id.slice(base.length + mark.length);
    // One spelling per attempt: the first is the bare id, so `_1` and a zero-padded number are nobody's.
    return /^[2-9]\d*$|^[1-9]\d+$/.test(rest) ? Number(rest) : undefined;
};

export interface FixAttempt<T extends { readonly id: string }> {
    readonly attempt: number;
    readonly agent: T;
}

// Every attempt at `base` among `agents`, earliest first. The roster is the record: nothing else files which
// conversations answered a failure, and none is needed, since the ids say so.
export const fixAttemptsOf = <T extends { readonly id: string }>(base: string, agents: Iterable<T>): FixAttempt<T>[] => {
    const attempts: FixAttempt<T>[] = [];
    for (const agent of agents) {
        const attempt = fixAttemptOf(base, agent.id);
        if (attempt !== undefined) {
            attempts.push({ attempt, agent });
        }
    }
    return attempts.toSorted((left, right) => left.attempt - right.attempt);
};

// The failure's live answer: its newest attempt, since an older one was set aside by the very act of starting a newer.
export const latestFixAttempt = <T extends { readonly id: string }>(base: string, agents: Iterable<T>): FixAttempt<T> | undefined =>
    fixAttemptsOf(base, agents).at(-1);

// The id the next attempt takes: one past every attempt KNOWN, archived ones included. A start-over files the last
// attempt away rather than deleting it, and a message to an archived conversation un-archives it, so minting a number
// the archive holds would quietly resurrect the attempt the reader just set aside.
export const nextFixAttemptId = (base: string, knownIds: Iterable<string>): string => {
    let highest = 0;
    for (const id of knownIds) {
        highest = Math.max(highest, fixAttemptOf(base, id) ?? 0);
    }
    return fixAttemptId(base, highest + 1);
};
