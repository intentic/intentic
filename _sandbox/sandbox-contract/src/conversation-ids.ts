/* THE NAME A NEW CONVERSATION IS BORN WITH.
 *
 * A conversation's id is not an internal key — it is the most PUBLIC string this app produces. The same value
 * becomes the git branch (`agent/<id>`), the worktree directory on disk, the id in the page's address, and the
 * name printed on every board card (SessionChip). So it is read far more often than it is dereferenced, and by
 * eyes rather than by code: in `git branch`, in a terminal `cd`, on a card in a lane of twenty.
 *
 * It used to be `crypto.randomUUID()`, and a UUID fails every one of those readings. Forty-two characters of
 * hex that no one can say, remember, or tell apart from the card next to it — two agents differ in the fourth
 * character and look identical at a glance, which is exactly when the board is being scanned rather than read.
 * It was also the widest line on a card that has a title to show. The app already knew this everywhere else:
 * the tmux session for the very same turn is called `agent-32b6cb04` (session-names.ts), eight characters,
 * because eight is what a human uses.
 *
 * So a new conversation gets a name instead: `swift-otter-k9m2`. The pair is the part a person actually uses —
 * sayable over a call, distinguishable at a glance, and memorable for the hour anyone cares about it. The
 * four-character tail is the part that makes it an id: the pairs alone would start colliding within a few
 * hundred conversations (a workspace passes that in a month), and a branch name that collides is a worktree
 * that refuses to be created. Random rather than a timestamp because a timestamp in base36 is eight characters
 * of its own and would put the length straight back.
 *
 * The shape satisfies ConversationIdSchema (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`) by construction — every word
 * here is lowercase a–z, the tail is lowercase base36, and the separator is the one the regex allows. That
 * guard is the injection guard for the branch name and the path, so it is the one thing about this module that
 * is not a matter of taste; the test beside it holds the whole generated space to it.
 *
 * Conversations the SANDBOX starts keep their own minters and their own prefixes (an automation's fire is
 * `a-<automation>-<time>`, a CI fix is minted from the run) — those names say WHERE the conversation came
 * from, which beats a random pair for a card the user did not ask for. This is the default for the ones a
 * person opens.
 */

/* The two halves of the name. Kept short (nothing over seven letters) because the whole point is a string that
 * fits on a card, and visually distinct from one another — no near-rhymes and no two words sharing a first
 * syllable, since a name is only useful here if it can be told apart from its neighbour in the lane. */
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

// How many base36 characters the disambiguating tail carries. Four is 1.7M values per word pair, which puts a
// collision far past the life of any workspace, and is still short enough to be ignored while reading.
const TAIL_LENGTH = 4;

// Uniform over the array, drawn from the platform CSPRNG — `Math.random()` is seeded per process, and two
// browser tabs opened in the same instant are exactly the case this must not produce the same name for.
const pick = <T>(values: readonly T[]): T => values[randomInts(1)[0]! % values.length]!;

const randomInts = (count: number): Uint32Array => crypto.getRandomValues(new Uint32Array(count));

// Lowercase base36, one character per drawn word — 0-9a-z, all of which the id guard accepts.
const tail = (): string => Array.from(randomInts(TAIL_LENGTH), (value) => (value % 36).toString(36)).join("");

/* A fresh conversation id: `<adjective>-<noun>-<tail>`, e.g. `swift-otter-k9m2`. Sixteen characters or so
 * against a UUID's thirty-six, and the first eleven of them are the ones a person reads. */
export const newConversationId = (): string => `${pick(ADJECTIVES)}-${pick(NOUNS)}-${tail()}`;
