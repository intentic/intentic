// @vitest-environment jsdom
//
// jsdom because the subject is what the card actually PUTS ON SCREEN — a press is only what the user sees come
// back, and a stat is only what renders. Landing an agent's work is a round trip to a daemon that has to
// commit, diff and patch-apply before the card can change lane, and for that whole span the only honest report
// is on the control that was pressed. Three properties are pinned here, and none can be read off the code: the
// Land button states its own progress; it states it for ITS action only — the card is equally busy while an
// archive is out, and a Land button spinning through one would be reporting work nobody asked for; and the
// stat row shows a fact the moment the agent has it, rather than waiting on numbers a turn only produces when
// it ends.
import type { AgentSummary } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h } from "vue";
import type { PendingAction } from "../composables/agents/laneDrop";
import type { FleetAgent } from "../composables/agents/useAgents";

// The card's import chain pulls in app-wide singletons that read browser globals at import time, stood up
// for the package by vitest.setup.ts — whose matches:false keeps the device DESKTOP, the form factor that
// renders the drill-in affordance beside the button.

const { default: AgentCard } = await import("./AgentCard.vue");
const { router } = await import("../router");

const NO_ATTENTION: AgentSummary[`attention`] = {
    plan: false,
    question: false,
    permission: false,
    service: false,
    capability: false,
    conflict: false,
};

// An agent holding finished work on its branch: auto-land off, nothing refused — the one state the card offers
// "Land now" for.
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

/* AN AGENT ON ITS FIRST TURN, delegating. Nothing is counted yet — no cost, no tokens, no completed turns, no
 * diff — because a turn produces all four when it ENDS, and this one is still running eight children. */
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
// Icon and v-tooltip are registered app-wide by installUi; stand-ins keep this off the whole UI plugin. Icon
// prints the glyph it was handed, because WHICH glyph is what says "in flight" on the button.
const mount = (agent: FleetAgent, pending?: PendingAction, handlers: { onClose?: () => void; onReland?: () => void } = {}): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        render: () =>
            h(AgentCard, {
                agent,
                now: 2,
                ...(pending !== undefined ? { pending } : {}),
                ...handlers,
            }),
    });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

/* A CONVERSATION THE FLEET NEVER REGISTERED, because the daemon refused its send. No branch, no diff, no entry
 * to address — which is what made this card the one the board could do nothing at all with. */
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

// The card dims for every action the board runs against it, archiving included — and the whole reason
// `pending` carries the action rather than a flag is that a Land button spinning through an archive would be
// reporting a land nobody asked for.
it(`leaves the land button alone while some other action holds the card`, () => {
    expect(landButton(mount(ready(), `archive`))?.textContent?.trim()).toBe(`Land now`);
});

// The end of the press, and the point of the whole exercise: the standing the daemon re-derives after a land
// takes the button off the card. Nothing about it is a local edit — the card simply has no land left to offer.
it(`drops the button once the work is in the workspace`, () => {
    expect(landButton(mount(ready(`landed`)))).toBeUndefined();
});

/* THE STAT ROW CARRIES WHAT THE AGENT HAS NOW. Its chips were gated on tokens/cost/diff/turns, and all four
 * only exist once a turn has ended — so an agent whose FIRST turn delegated ran eight children with the board
 * saying nothing, which is the exact case the count was added for. The row is the only surface that outlives
 * the turn (the live line below it goes with the spinner), so this is not a duplicate of that line. */
it(`counts the agents it started while its first turn is still running`, () => {
    expect([...mount(delegating()).querySelectorAll(`button`)].some((button) => button.textContent?.trim() === `8 / 8`)).toBe(true);
});

/* THE CARD THE BOARD COULD DO NOTHING WITH. A refused send leaves a conversation the daemon never registered,
 * and every exit on this board goes through the daemon by id: archive, discard, land and each drop are refused
 * for it, correctly and unanimously. What that left was a card offering a rename and nothing else — permanent,
 * because the tab behind it is restored on every reload. So the exit it DOES have, closing that tab, is offered
 * on the card itself instead of only on the chat rail, which the board never points at. */
it(`offers a close on a card the daemon has no entry for — the only way it can leave the board`, () => {
    expect(buttonLabelled(mount(refused()), `Close agent`)).not.toBeUndefined();
});

it(`asks the board to close it on the press`, () => {
    const closed = vi.fn();
    buttonLabelled(mount(refused(), undefined, { onClose: closed }), `Close agent`)!.click();
    expect(closed).toHaveBeenCalledTimes(1);
});

// The two never appear together, which is what lets them share one slot: an agent the daemon knows is ARCHIVED
// (its branch, diff and transcript all kept), and one it has never heard of is CLOSED, because there is nothing
// to keep. Offering the wrong one is worse than offering neither — an archive here posts an id that 404s.
it(`withholds the archive from a card with no entry to archive`, () => {
    expect(buttonLabelled(mount(refused()), `Archive agent`)).toBeUndefined();
});

it(`withholds the close from a registered agent, which archives instead`, () => {
    const landed = mount(ready(`landed`));
    expect(buttonLabelled(landed, `Close agent`)).toBeUndefined();
    expect(buttonLabelled(landed, `Archive agent`)).not.toBeUndefined();
});

/* THE CARD OF A TURN THAT IS COMING BACK. A rotated credential 401s every turn holding it at once, and the
 * daemon re-mints and re-runs them within a scheduler pass — so what the card has to draw for those seconds is
 * work still in progress. It read `idle` instead, which is the Finished lane: the board filed the agent away
 * and then took it back out, in front of a user who had done nothing and was owed nothing.
 *
 * Asserted on the RENDERED card rather than on laneOf alone, because the two halves have to agree — a lane that
 * says "still working" under a resting glyph is the same contradiction one surface further in. The archive goes
 * with it: the worktree belongs to a turn that is about to run in it again, which is what turnInFlight means. */
it(`draws an agent whose turn is being resumed as work still in flight`, () => {
    const card = mount(ready(`resuming`));
    expect(card.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
    expect(buttonLabelled(card, `Archive agent`)).toBeUndefined();
});

/* THE CARD OF A TURN THAT HAS GONE AND HAS NOT BEEN FILED YET.
 *
 * It was drawn from the four identity fields alone, so the board showed a title under a spinner and nothing
 * else — no model, no elapsed — and the click that was supposed to open it took it off the board instead. What
 * is pinned here is the half the user reads: the card says it is starting, its elapsed runs from the send, and
 * the exit stays on it. */
const starting = (): FleetAgent => ({
    id: `a4`,
    status: `starting`,
    provider: `claude`,
    harness: `native`,
    title: `check the vue patterns`,
    model: `claude-opus-5`,
    updatedAt: 0,
    startedAt: 1,
    attention: NO_ATTENTION,
    open: true,
    unread: false,
    unsent: false,
});

it(`draws a sent turn the daemon has not filed as work in flight, with what this browser knows`, () => {
    const card = mount(starting());
    expect(card.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
    // The model it went out under, and an elapsed measured from the send — `now` is 2ms against a 1ms start.
    expect(card.textContent).toContain(`Claude Opus 5`);
    expect(card.textContent).toContain(`0s`);
});

/* The exit, on the state that most needs one. Its turn is genuinely running daemon-side, so the daemon has no
 * entry to archive and no id these buttons could address — and a card with neither affordance is the trap this
 * pair of rules exists to prevent. */
it(`keeps a close on it and withholds the archive it has no entry for`, () => {
    const card = mount(starting());
    expect(buttonLabelled(card, `Close agent`)).not.toBeUndefined();
    expect(buttonLabelled(card, `Archive agent`)).toBeUndefined();
});

/* WHY IT DIED, ON THE CARD. An unattended session refused on its first request — an organization with Claude
 * Code switched off, a spent plan, a model an endpoint has never heard of — used to reach the board as the word
 * "Error" and a link into a transcript whose entire content was the sentence the card should have carried. The
 * fan-out that provoked this ran ten sessions at once and lost every one of them the same way, so the reader's
 * only route to the reason was ten separate conversations. */
it(`says why a session died, on the card that reports it died`, () => {
    const card = mount({ ...ready(`error`), failure: `Your organization has disabled Claude subscription access for Claude Code` });
    expect(card.textContent).toContain(`Your organization has disabled Claude subscription access`);
});

// The daemon carries `failure` only while the card still reads as failed, so presence IS the state and the card
// needs no second check — but a healthy card must not grow an empty red line out of the same markup.
it(`keeps the line off a card with nothing to explain`, () => {
    expect(mount(ready()).querySelector(`[data-icon="exclamation-circle"]`)).toBeNull();
});

/* THE DISCARD CASE — landed work the user has since taken back out of the workspace.
 *
 * It is the one state on this board the card could not previously report, and the reason is structural: every
 * other reading here is taken between commits, and discarding uncommitted changes moves no commit. So the card
 * went on wearing `Landed` over a tree holding none of it. Four properties are pinned: the card SAYS so; it
 * offers the way back; the offer is not the primary press (a discard is very often a rejection, and a bright
 * green button would be arguing with it); and where a plain land would also apply, this one replaces it —
 * "Land now" carries the remainder and would leave the missing half exactly as missing. */
const discarded = (present: number, landed: number, status: FleetAgent[`status`] = `landed`): FleetAgent => ({
    ...ready(status),
    landedPresence: { landed, present },
});

const relandButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => /Land again|Landing/.test(button.textContent ?? ``));

it(`says so when the whole of a land has left the workspace`, () => {
    expect(mount(discarded(0, 4)).textContent).toContain(`Removed from your workspace`);
});

// The fraction, not the remainder: what the user is deciding is whether enough survived to leave it be, and
// "9 of 12" answers that without them doing the subtraction.
it(`counts what survived when only part of a land was discarded`, () => {
    expect(mount(discarded(9, 12)).textContent).toContain(`9 of 12 files still in your workspace`);
});

/* The half that stops "removed from your workspace" reading as work destroyed. It is not decoration: the
 * branch genuinely still holds all of it, and that fact is what makes the discard safe to have made.
 * A CLAUSE ON THE SAME LINE, not a paragraph under a button — hence the assertion on the joined sentence. The
 * old wording spent two lines saying it, half of them narrating the button directly above them. */
it(`says the work is not lost, in the same breath`, () => {
    expect(mount(discarded(0, 4)).textContent).toContain(`Removed from your workspace — still on its branch`);
});

// The partial reading names the OTHER half: the fraction already said what is here, so the clause is only
// worth its words about what is not.
it(`points a partial discard at where the missing files still are`, () => {
    expect(mount(discarded(9, 12)).textContent).toContain(`still in your workspace — the rest is on its branch`);
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

/* THE TWO NEVER SHARE A CARD. An agent whose first land was discarded and which has since written more is
 * `ready` AND missing work, and the two presses are not interchangeable: "Land now" applies the outstanding
 * remainder and leaves the discarded half untouched — a land that reports success and fixes nothing, which is
 * the hardest kind of wrong to notice. "Land again" measures from the branch's base and covers both. */
it(`replaces the plain land rather than sitting beside it`, () => {
    const card = mount(discarded(0, 4, `ready`));
    expect(relandButton(card)?.textContent?.trim()).toBe(`Land again`);
    expect(landButton(card)).toBeUndefined();
});

// Nothing missing is the steady state and says NOTHING — a card that announced the ordinary landed agent would
// be spending a line on nearly every card on the board.
it(`stays quiet when the landed work is where it was left`, () => {
    const card = mount(ready(`landed`));
    expect(relandButton(card)).toBeUndefined();
    expect(card.textContent).not.toContain(`your workspace`);
});
