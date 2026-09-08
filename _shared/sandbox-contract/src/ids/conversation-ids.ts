// A conversation's id is the most public string this app produces: the git branch, the worktree directory, the URL, and
// the card title. `adjective-noun-tail` reads at a glance; the tail keeps it unique and must satisfy
// ConversationIdSchema. Sandbox-started conversations use their own prefixed, derived ids instead.

// The injection guard every path that interpolates a conversation id relies on: is this safe to put in a path.
export const CONVERSATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// Safe to interpolate into a path or a branch name. `false` for anything else, including the empty string.
export const isConversationId = (value: string): boolean => CONVERSATION_ID.test(value);

// Short (nothing over seven letters) and visually distinct: no near-rhymes, no shared first syllable.
const ADJECTIVES = [
    "amber",
    "brave",
    "brisk",
    "calm",
    "clear",
    "coral",
    "crisp",
    "deft",
    "eager",
    "fair",
    "fleet",
    "glad",
    "grand",
    "keen",
    "kind",
    "lively",
    "lucid",
    "mellow",
    "merry",
    "mild",
    "noble",
    "plain",
    "prime",
    "proud",
    "quick",
    "quiet",
    "rapid",
    "ready",
    "rich",
    "ripe",
    "sharp",
    "sleek",
    "smart",
    "snug",
    "solid",
    "spry",
    "stark",
    "steady",
    "still",
    "stout",
    "sunny",
    "swift",
    "tidy",
    "true",
    "vivid",
    "warm",
    "wise",
    "witty",
] as const;

const NOUNS = [
    "alder",
    "anchor",
    "arbor",
    "arrow",
    "aspen",
    "badger",
    "basin",
    "beacon",
    "birch",
    "bison",
    "cedar",
    "cinder",
    "comet",
    "condor",
    "cove",
    "crane",
    "delta",
    "ember",
    "falcon",
    "fern",
    "fjord",
    "forge",
    "gale",
    "glade",
    "harbor",
    "heron",
    "ivy",
    "lantern",
    "ledger",
    "lichen",
    "lynx",
    "maple",
    "marsh",
    "meadow",
    "mesa",
    "moth",
    "otter",
    "pebble",
    "pine",
    "quarry",
    "quill",
    "raven",
    "reef",
    "ridge",
    "rowan",
    "sable",
    "sage",
    "shale",
    "spruce",
    "summit",
    "thistle",
    "tundra",
    "vale",
    "willow",
    "wren",
] as const;

// Four base36 characters is 1.7M values per word pair, far past any workspace's collision risk.
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

// Lowercase base36, one character per draw: 0-9a-z, all of which the id guard accepts.
const tail = (): string => Array.from({ length: TAIL_LENGTH }, () => randomBelow(36).toString(36)).join("");

// A fresh id: `<adjective>-<noun>-<tail>`, e.g. `swift-otter-k9m2`; about sixteen characters against a UUID's
// thirty-six.
export const newConversationId = (): string => `${pick(ADJECTIVES)}-${pick(NOUNS)}-${tail()}`;

// Derived, not drawn, so a re-computed id says whether an agent is already on this failure and a second press continues
// it. The repo is included (one run id per project) and slugified, not hashed, since people read it.
export const CI_FIX_PREFIX = "ci-fix-";
// Leaves ~24 characters for the run id within the 64-char id limit, twice the widest either forge mints.
const REPO_SLUG_MAX = 32;
const repoSlug = (repo: string): string =>
    repo
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, REPO_SLUG_MAX)
        .replace(/^-+|-+$/g, "") || "repo";
export const ciFixConversationId = (repo: string, runId: number): string => `${CI_FIX_PREFIX}${repoSlug(repo)}-${runId}`;

// Keyed by which gates failed (fixSignature), not a run id (a push has none); the same gates red again is the same
// failure. Hashed rather than spelled into the branch name; the fix agent's first message names the gates.
export const PUSH_FIX_PREFIX = "push-fix-";

// FNV-1a, not a cryptographic hash: nothing here is secret, the only requirement is the same failure yields the same
// seven characters in every browser and in node.
const FNV_OFFSET = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;
const digest = (text: string): string => {
    let hash = FNV_OFFSET;
    for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME);
    }
    return (hash >>> 0).toString(36).padStart(7, "0");
};

export const pushFixConversationId = (scope: string, signature: string): string => `${PUSH_FIX_PREFIX}${repoSlug(scope)}-${digest(signature)}`;
