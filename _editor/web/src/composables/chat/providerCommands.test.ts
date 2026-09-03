// @vitest-environment jsdom
//
/* THE `/` POPOVER'S LIST, AND THE RACE IT USED TO LOSE.
 *
 * A provider's slash commands are learned daemon-side from its first TURN and held in memory. This client read
 * them once, at page load, for `claude` alone. So a tab opened before any turn had run in that daemon's
 * lifetime — every reload right after a restart or a deploy — cached an empty list, nothing re-asked, and every
 * conversation opened in that tab had a dead `/` popover for the rest of the session. The reported symptom was
 * exactly that: nothing on `/`, then the full list "for no reason" once a turn had happened to run.
 *
 * ensureProviderCommands is the re-ask, and these are the four properties the composer depends on: it asks for
 * the provider it was given (not just Claude), it asks again while there is nothing to show, it never asks once
 * there is, and a switch of sandbox cannot land the outgoing daemon's vocabulary in the incoming one's record.
 */
import { beforeEach, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ paths: [] as string[], answer: [] as { name: string; description: string }[] }));

// The one seam these properties are about. Everything else a mounted chat would fetch is out of scope here:
// this file drives the loader directly, so an unrelated path answering empty is the honest stand-in.
vi.mock(`../sandbox/sandboxClient`, () => ({
    sandboxJson: vi.fn((path: string) => {
        reads.paths.push(path);
        return path.startsWith(`/agent/commands`) ? Promise.resolve({ commands: reads.answer }) : Promise.resolve({});
    }),
    sandboxRequest: vi.fn(() => Promise.resolve(new Response(`{}`))),
    sandboxRequestVia: vi.fn(() => Promise.resolve(new Response(`{}`))),
    sandboxError: vi.fn(() => new Error(`unused`)),
}));

// Static, because vitest.setup.ts has already installed the globals these modules read at import scope.
import { providerCommands } from "./providerCatalog";
import { ensureProviderCommands, resetChat } from "./useChat";

const commandReads = (): string[] => reads.paths.filter((path) => path.startsWith(`/agent/commands`));

beforeEach(() => {
    reads.paths.length = 0;
    reads.answer = [{ name: `compact`, description: `Summarize the conversation` }];
    resetChat();
});

/* The half that was never wired at all. `loadAccountStatus` asks for `claude` and nothing else, so a pane on
 * any other provider read an empty record no matter what its daemon knew — and the user's conversations run on
 * several. The provider the composer is ON is the one that gets asked. */
it(`asks for the provider it was given, not only claude`, async () => {
    await ensureProviderCommands(`cursor`);

    expect(commandReads()).toEqual([`/agent/commands?agent=cursor`]);
    expect(providerCommands.value[`cursor`]).toEqual([{ name: `compact`, description: `Summarize the conversation` }]);
});

/* THE REPORTED BUG, as a sequence. The first read lands while the daemon has served no turn, so it answers
 * empty and the popover has nothing; the next time a composer needs the list it asks again, and by then the
 * daemon has it. Without the re-ask this second call never happens and the tab stays broken until reload. */
it(`asks again while the list is still empty, so a read that came back too early self-heals`, async () => {
    reads.answer = [];
    await ensureProviderCommands(`claude`);
    expect(providerCommands.value[`claude`]).toEqual([]);

    reads.answer = [{ name: `compact`, description: `Summarize the conversation` }];
    await ensureProviderCommands(`claude`);

    expect(commandReads()).toHaveLength(2);
    expect(providerCommands.value[`claude`]).toHaveLength(1);
});

/* The other side of that rule, and what keeps the retry from becoming a poll: a populated list is the final
 * answer for this daemon's life. The composer calls this on every `/` keystroke's worth of state change, so a
 * version that re-read each time would put a request behind every slash the user ever types. */
it(`never re-reads a list it already has`, async () => {
    await ensureProviderCommands(`claude`);
    await ensureProviderCommands(`claude`);
    await ensureProviderCommands(`claude`);

    expect(commandReads()).toHaveLength(1);
});

// Two panes mounting together, or a provider switch racing a keystroke, are one request: the second asker
// joins the first rather than opening its own.
it(`shares one request between concurrent askers`, async () => {
    await Promise.all([ensureProviderCommands(`claude`), ensureProviderCommands(`claude`), ensureProviderCommands(`claude`)]);

    expect(commandReads()).toHaveLength(1);
});

/* A READ IN FLIGHT WHEN THE SANDBOX CHANGED IS ANSWERING ABOUT THE BOX THE USER LEFT. Applying it would offer
 * commands the incoming sandbox may not have, and an unknown `/name` is not an inert typo: the CLI claims the
 * leading slash, finds no such command and discards the REST of the message, so the turn ends having thrown
 * away what the user actually wrote. */
it(`drops an answer that arrives after a sandbox switch`, async () => {
    const inFlight = ensureProviderCommands(`claude`);
    resetChat();
    await inFlight;

    expect(providerCommands.value[`claude`]).toEqual([]);
});
