import { callsFor, cardsFor, heardBy, type Reader } from "./notifyAudience";

// The tab rings, and the Agents badge counts, only what the daemon would push to the same person: the conversations they
// took part in or follow, as much of each as they asked for; a card nobody took part in is the operators'.

const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const asking = { status: `awaiting` as const, attention: { ...none, question: true }, updatedAt: 1_000 };
const ADA: Reader = { email: `ada@example.com`, operates: false };
const OWNER: Reader = { email: `own@example.com`, operates: true };

const fleet = [
    { id: `mine`, ...asking, owner: { email: `ada@example.com`, since: 1 } },
    { id: `bobs`, ...asking, owner: { email: `bob@example.com`, since: 1 } },
    { id: `joined`, ...asking, owner: { email: `bob@example.com`, since: 1 }, participants: [{ email: `ada@example.com`, since: 2, via: `answer` as const }] },
    { id: `muted`, ...asking, owner: { email: `ada@example.com`, since: 1 }, notify: [{ email: `ada@example.com`, level: `none` as const, at: 3 }] },
    { id: `program`, ...asking, startedBy: `token:deploy-bot` },
];

test("a reader hears the cards of what they took part in and did not turn off, and nothing of anyone else's", () => {
    expect(callsFor(fleet, ADA).map((call) => call.id)).toEqual([`mine`, `joined`]);
    expect(cardsFor(fleet, ADA)).toBe(2);
});

// As on the daemon: a card nobody hears is an agent stopped for good, so one whose only person turned it off goes up too.
test("a card nobody took part in, or whose people all turned it off, waits on whoever runs the sandbox", () => {
    expect(callsFor(fleet, OWNER).map((call) => call.id)).toEqual([`muted`, `program`]);
    expect(callsFor(fleet, { ...OWNER, operates: false })).toEqual([]);
});

test("the owner's own tools, signed in as nobody, hear everything", () => {
    expect(cardsFor(fleet, { email: undefined, operates: true })).toBe(5);
});

test("asking only for what waits on you keeps the cards and drops the finished turns", () => {
    const quiet = { owner: { email: `ada@example.com`, since: 1 }, notify: [{ email: `ada@example.com`, level: `asks` as const, at: 1 }] };
    expect(heardBy(quiet, ADA, `asks`)).toBe(true);
    expect(heardBy(quiet, ADA, `finished`)).toBe(false);
    // Following a conversation one took no part in hears all of it.
    expect(heardBy({ notify: [{ email: `ada@example.com`, level: `all`, at: 1 }] }, ADA, `finished`)).toBe(true);
});
