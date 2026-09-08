// @vitest-environment jsdom
// jsdom: the subject is what the card renders (a press, a stat), not something readable off the code.
// Pins that the Land button reports progress only for its own action (not archiving), and that the stat row shows a
// fact as soon as the agent has it, not only when a turn ends.
import type { AgentSummary } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import type { PendingAction } from "./laneDrop";
import type { FleetAgent } from "../fleet/useAgents-fleet";
import { IconStub } from "@intentic/ui/testing";

// Import chain reads browser globals at import time; setup keeps the device desktop for the drill-in affordance.

const { default: AgentCard } = await import("./AgentCard.vue");
const { router } = await import("../../../router");
// Connected accounts module state; the card reads it to turn a session's account id into a name.
const { providerAccounts } = await import("../../chat/accounts/providerAccounts");
const NO_ACCOUNTS = providerAccounts.value;

const NO_ATTENTION: AgentSummary[`attention`] = {
    plan: false,
    question: false,
    permission: false,
    capability: false,
    credential: false,
    conflict: false,
};

// Agent holding finished work on its branch, auto-land off; the one status the card offers "Land now" for.
const ready = (status: FleetAgent[`status`] = `ready`): FleetAgent => ({
    id: `a1`,
    status,
    provider: `claude`,
    harness: `native`,
    branch: `agent/a1`,
    title: `fix the thing`,
    updatedAt: 1,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
});

// Agent on its first turn, delegating: no cost/tokens/turns/diff yet, since those exist only once a turn ends; still
// running eight children.
const delegating = (): FleetAgent => ({
    id: `a2`,
    status: `running`,
    provider: `claude`,
    harness: `native`,
    title: `analyse the gap`,
    updatedAt: 1,
    startedAt: 1,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    activity: { tool: `Agent` },
    subagents: { running: 8, total: 8 },
});

let app: App | undefined;
// Icon and v-tooltip are registered app-wide by installUi; stand-ins here avoid pulling in the whole UI plugin.
// IconStub prints the glyph it's given, since which glyph is what shows a button is in flight.
const mount = (
    agent: FleetAgent,
    pending?: PendingAction,
    handlers: { onClose?: () => void; onReland?: () => void; onUnwatch?: () => void } = {},
): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        render: () =>
            h(AgentCard, {
                agent,
                ...(pending !== undefined ? { pending } : {}),
                ...handlers,
            }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    vi.useRealTimers();
    document.body.innerHTML = ``;
    providerAccounts.value = NO_ACCOUNTS;
});

// A conversation the daemon refused to register: no branch, no diff, no entry to address.
// The one card the board can do nothing with by id.
const refused = (): FleetAgent => ({
    id: `a3`,
    status: `failed`,
    provider: `claude`,
    harness: `native`,
    title: `make the subagent limit configurable`,
    updatedAt: 0,
    attention: NO_ATTENTION,
    open: true,
    unread: false,
    unsent: false,
});

// The corner's status glyph: the one element that says how the card settled, by its accessible name.
const corner = (el: HTMLElement): HTMLElement | null => el.querySelector(`[role="img"]`);

/* ONE CORNER, BOTH FACTS. A finished lane of cards each wearing a green check in the corner and an amber
 * "Unfinished" pill in the body was two answers to one question; the pill is gone, and a turn that stopped short
 * is a dot on the glyph with the sentence in the hover. The glyph itself is unchanged, since "landed" is still
 * where the work is. */
it(`marks a turn that stopped short on the status glyph, not on a chip of its own`, () => {
    const el = mount({
        ...ready(`landed`),
        // Dated now: the card's clock is the real one for a resting card, and the hover ages the mark against it.
        unfinished: { at: Date.now(), steps: { open: 1, total: 5, next: `Restore reachability so radarsu-omen can pair` } },
    });
    expect(el.textContent).not.toContain(`Unfinished`);
    const glyph = corner(el)!;
    expect(glyph.querySelector(`[data-icon="check-circle"]`)).not.toBeNull();
    expect(glyph.querySelector(`[data-unfinished]`)).not.toBeNull();
    expect(glyph.getAttribute(`aria-label`)).toBe(
        `Landed. Stopped with 1 of 5 steps unfinished, just now: Restore reachability so radarsu-omen can pair`,
    );
});

it(`wears a plain glyph once nothing was left open`, () => {
    const glyph = corner(mount(ready(`landed`)))!;
    expect(glyph.querySelector(`[data-unfinished]`)).toBeNull();
    expect(glyph.getAttribute(`aria-label`)).toBe(`Landed`);
});

const landButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => /Land now|Landing/.test(button.textContent ?? ``));

const buttonLabelled = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.getAttribute(`aria-label`) === label);

it(`offers the land on the card, so finished work needs no second surface to release it`, () => {
    expect(landButton(mount(ready()))?.textContent?.trim()).toBe(`Land now`);
});

it(`answers the press on the button that was pressed, glyph and words`, () => {
    const button = landButton(mount(ready(), `land`))!;
    expect(button.textContent?.trim()).toBe(`Landing…`);
    expect(button.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
});

// The card dims for any pending action (archiving included); `pending` carries which action, not just a flag.
// Otherwise a Land button would spin through an archive, reporting a land nobody asked for.
it(`leaves the land button alone while some other action holds the card`, () => {
    expect(landButton(mount(ready(), `archive`))?.textContent?.trim()).toBe(`Land now`);
});

// Once the daemon re-derives status after a land, the button is simply gone, not locally hidden.
it(`drops the button once the work is in the workspace`, () => {
    expect(landButton(mount(ready(`landed`)))).toBeUndefined();
});

// Stat chips (tokens, cost, diff, turns) only exist once a turn ends; an agent whose first turn delegates shows none,
// though it's running eight children.
// The row is the only surface that outlives the turn once the live line with the spinner goes.
// A link, not a button, since the count names an addressable list (Subagents narrowed to this agent's children) you can
// hover, copy, or Ctrl/Cmd-click into its own tab.
it(`counts the agents it started while its first turn is still running`, () => {
    const chip = [...mount(delegating()).querySelectorAll(`a`)].find((link) => link.textContent?.trim() === `8 / 8`);
    expect(chip).toEqual(expect.any(Object));
});

// A refused send has no daemon entry, so every id-based exit (archive, discard, land) is unavailable, correctly.
// Closing the tab is the only exit possible, so it's offered on the card itself, not only on the chat rail.
it(`offers a close on a card the daemon has no entry for: the only way it can leave the board`, () => {
    expect(buttonLabelled(mount(refused()), `Close agent`)).not.toBeUndefined();
});

it(`asks the board to close it on the press`, () => {
    const closed = vi.fn();
    buttonLabelled(mount(refused(), undefined, { onClose: closed }), `Close agent`)!.click();
    expect(closed).toHaveBeenCalledTimes(1);
});

// Archive and Close never appear together and share one slot: registered work gets Archive (kept), an unregistered
// conversation gets Close (nothing to keep).
// Offering the wrong one is worse than neither: an archive here would post an id that 404s.
it(`withholds the archive from a card with no entry to archive`, () => {
    expect(buttonLabelled(mount(refused()), `Archive agent`)).toBeUndefined();
});

it(`withholds the close from a registered agent, which archives instead`, () => {
    const landed = mount(ready(`landed`));
    expect(buttonLabelled(landed, `Close agent`)).toBeUndefined();
    expect(buttonLabelled(landed, `Archive agent`)).not.toBeUndefined();
});

// A `resuming` agent (its turn restarting after e.g. a credential rotation) must render as work in flight, not as
// idle/finished.
// Archive is withheld too: the worktree belongs to a turn about to run in it again.
it(`draws an agent whose turn is being resumed as work still in flight`, () => {
    const card = mount(ready(`resuming`));
    expect(card.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
    expect(buttonLabelled(card, `Archive agent`)).toBeUndefined();
});

// A sent turn the daemon hasn't filed yet: drawn from identity fields alone, showing just a title under a spinner.
// Pinned here: it shows starting, elapsed runs from send, and the close exit stays available.
const starting = (): FleetAgent => ({
    id: `a4`,
    status: `starting`,
    provider: `claude`,
    harness: `native`,
    title: `check the vue patterns`,
    model: `claude-opus-5`,
    updatedAt: 0,
    startedAt: Date.now(),
    attention: NO_ATTENTION,
    open: true,
    unread: false,
    unsent: false,
});

it(`draws a sent turn the daemon has not filed as work in flight, with what this browser knows`, () => {
    const card = mount(starting());
    expect(card.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
    // The model it went out under, and an elapsed measured from the send.
    expect(card.textContent).toContain(`Claude Opus 5`);
    expect(card.textContent).toContain(`0s`);
});

it(`ticks its own elapsed readout without a clock prop from the transition group`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const card = mount(starting());
    expect(card.textContent).toContain(`0s`);

    await vi.advanceTimersByTimeAsync(1_000);
    await nextTick();
    expect(card.textContent).toContain(`1s`);
});

// A `starting` turn has no daemon entry yet, so archive is unavailable; close must stay, or the card would offer no
// exit at all.
it(`keeps a close on it and withholds the archive it has no entry for`, () => {
    const card = mount(starting());
    expect(buttonLabelled(card, `Close agent`)).not.toBeUndefined();
    expect(buttonLabelled(card, `Archive agent`)).toBeUndefined();
});

// A session refused on its first request (access disabled, spent plan, unknown model) shows its failure reason directly
// on the card, not just an opaque "Error".
it(`says why a session died, on the card that reports it died`, () => {
    const failure = `Your organization has disabled Claude subscription access for Claude Code`;
    const card = mount({ ...ready(`error`), failure });
    expect(card.textContent).toContain(failure.slice(0, 40));
});

// `failure` is present only while the card reads as failed; a healthy card must not render an empty line from the same
// markup.
it(`keeps the line off a card with nothing to explain`, () => {
    expect(mount(ready()).querySelector(`[data-icon="exclamation-circle"]`)).toBeNull();
});

// Landed work later discarded from the workspace: the card must say so, offer a way back (not as the primary/green
// press), and this replaces "Land now" rather than sitting beside it where both would apply.
const discarded = (present: number, landed: number, status: FleetAgent[`status`] = `landed`): FleetAgent => ({
    ...ready(status),
    landedPresence: { landed, present },
});

const relandButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => /Land again|Landing/.test(button.textContent ?? ``));

it(`says so when the whole of a land has left the workspace`, () => {
    const card = mount(discarded(0, 4));
    expect(card.textContent).toContain(`Removed`);
    expect(card.textContent).toContain(`on branch`);
});

// Shows the fraction that survived, not the remainder: the question is whether enough survived to leave it.
it(`counts what survived when only part of a land was discarded`, () => {
    expect(mount(discarded(9, 12)).textContent).toContain(`9/12`);
});

// Pairs with 'Removed' so it doesn't read as destroyed: the branch still holds all of it.
it(`says the work is not lost, in the same breath`, () => {
    expect(mount(discarded(0, 4)).textContent ?? ``).toContain(`on branch`);
});

it(`shows a compact fraction when only part of a land was discarded`, () => {
    const card = mount(discarded(1, 2));
    expect(card.textContent ?? ``).toContain(`1/2`);
    expect(card.querySelector(`[data-icon="arrows-h"]`)).not.toBeNull();
});

it(`offers the way back, and reports its own press`, () => {
    expect(relandButton(mount(discarded(0, 4)))?.textContent?.trim()).toBe(`Land again`);
    const pressed = relandButton(mount(discarded(0, 4), `reland`))!;
    expect(pressed.textContent?.trim()).toBe(`Landing…`);
    expect(pressed.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
});

it(`asks the board to re-land on the press`, () => {
    const relanded = vi.fn();
    relandButton(mount(discarded(0, 4), undefined, { onReland: relanded }))!.click();
    expect(relanded).toHaveBeenCalledTimes(1);
});

// Land now and Land again never share a card: Land now applies only the new remainder and leaves the discarded half
// untouched.
// Land again measures from the branch's base and covers both, so it replaces Land now rather than sitting beside it.
it(`replaces the plain land rather than sitting beside it`, () => {
    const card = mount(discarded(0, 4, `ready`));
    expect(relandButton(card)?.textContent?.trim()).toBe(`Land again`);
    expect(landButton(card)).toBeUndefined();
});

// The steady state (nothing missing) says nothing; announcing it would cost a line on nearly every card.
it(`stays quiet when the landed work is where it was left`, () => {
    const card = mount(ready(`landed`));
    expect(relandButton(card)).toBeUndefined();
    expect(card.textContent).not.toContain(`your workspace`);
});

// A watch keeps a hosted machine awake and lets the agent resume by itself later; the stop press sits beside the
// readout that announces it.
// It asks the board rather than acting locally, disappears once a turn resumes, and survives into the archive since a
// watch can pull a filed-away agent back.
const watching = (over: Partial<FleetAgent> = {}): FleetAgent => ({
    ...ready(`idle`),
    watches: [{ id: `watch-1`, note: `pnpm verify gate in /work/intentic`, intervalSeconds: 30, deadlineAt: 2 + 13 * 60 * 1000 }],
    ...over,
});

const stopWatchButton = (el: HTMLElement): HTMLButtonElement | undefined => buttonLabelled(el, `Stop watching`);

it(`offers the way off a watch beside the readout that announces it`, () => {
    const card = mount(watching());
    expect(card.textContent).toContain(`pnpm verify gate in /work/intentic`);
    expect(stopWatchButton(card)?.textContent?.trim()).toBe(`Stop`);
});

it(`asks the board to disarm on the press`, () => {
    const unwatched = vi.fn();
    stopWatchButton(mount(watching(), undefined, { onUnwatch: unwatched }))!.click();
    expect(unwatched).toHaveBeenCalledTimes(1);
});

// Most cards aren't watching anything; a Stop button there would offer to end something not happening.
it(`shows no such press on a card that is waiting for nothing`, () => {
    expect(stopWatchButton(mount(ready(`idle`)))).toBeUndefined();
});

// The watch readout yields its corner to a running turn; the stop press goes with it rather than pointing at a line no
// longer on the card.
it(`withdraws it while a turn is in flight, with the readout it belongs to`, () => {
    const card = mount(watching({ status: `running`, startedAt: 1 }));
    expect(card.textContent).not.toContain(`pnpm verify gate`);
    expect(stopWatchButton(card)).toBeUndefined();
});

// The one exception to withholding presses on an archived card: every other press could undo the filing, but Stop keeps
// it filed.
it(`keeps it on an archived card, the one press that stops one waking back onto the board`, () => {
    expect(stopWatchButton(mount(watching({ archivedAt: 5 })))).toEqual(expect.any(Object));
});

// Names the machine an agent runs on, since the fleet places fan-out across machines without a per-agent choice
// (runners/runner-scheduler.ts).
// Silent when it runs here, so every ordinary card is unchanged.
it(`names the machine an agent runs on, and says nothing when it runs here`, () => {
    expect(mount({ ...ready(), runner: `rig` }).textContent ?? ``).toContain(`rig`);
    expect(mount(ready()).textContent ?? ``).not.toContain(`rig`);
});

// Names which login a session's turns are charged to, since the choice (personal vs work plan) is made once in the
// composer and otherwise unreadable afterward.
// The summary carries only a UUID; an id the account list can't resolve (a disconnected login) draws nothing, since a
// bare UUID names less than silence.
it(`names the login a session's turns run on, and stays silent about one it cannot name`, () => {
    providerAccounts.value = { ...NO_ACCOUNTS, claude: [{ id: `acct-1`, label: `acme-work@acme.com`, connectedAt: 1 }] };
    expect(mount({ ...ready(), account: `acct-1` }).textContent ?? ``).toContain(`acme-work`);
    expect(mount({ ...ready(), account: `disconnected-since` }).textContent ?? ``).not.toContain(`acme-work`);
});
