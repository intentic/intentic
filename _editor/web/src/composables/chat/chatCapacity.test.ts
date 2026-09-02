import type { AccountUsage, OauthAccount, TranslatorAccount, TranslatorAccounts } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, it } from "vitest";
import { CAPACITY_RAIL_PX, chatCapacity, hasCapacity, railFitsBeside } from "./chatCapacity";
import { providerAccounts, providerRefusals, translatorAccounts, usageByAccount } from "./providerAccounts";

/* The rail's whole argument is what it LEAVES OUT, so that is what this pins: an offer list is only worth
 * reading if everything on it can actually serve a turn, and only trustworthy if everything it drops is still
 * accounted for somewhere.
 *
 * These are the four ways the list can lie, and each has a test:
 *   · offering an account whose pool is spent;
 *   · offering one that publishes full pools and refuses everything (a dead credential, a withdrawn seat);
 *   · dropping a provider silently, so "spent until Sunday" and "never connected" render identically;
 *   · spending the column on thirty-one gmail addresses nobody chooses between.
 */

const NOW = 1_700_000_000_000;
const NO_ROUTED: TranslatorAccounts = { codex: [], grok: [], kimi: [], gemini: [] };

// A fresh reading, so nothing here is judged stale: staleness is usageStatus's subject, not this one.
const usage = (percent: number, resetsAt = 1_700_003_600): AccountUsage => ({
    measuredAt: NOW - 60_000,
    windows: [{ kind: `seven_day`, utilization: percent, resetsAt, gates: `all` }],
});

const claude = (over: Partial<OauthAccount>): OauthAccount => ({ id: `acc`, label: `first@example.com`, connectedAt: 0, ...over });

const google = (index: number, percent: number): TranslatorAccount => ({
    name: `gemini-${index}`,
    label: `radarsuspam${index}@gmail.com`,
    usage: usage(percent),
});

afterEach(() => {
    providerAccounts.value = {};
    translatorAccounts.value = NO_ROUTED;
    providerRefusals.value = {};
    usageByAccount.value = {};
});

describe(`what the rail offers`, () => {
    it(`lists the accounts with room, roomiest first, and holds back the ones that are spent`, () => {
        providerAccounts.value = {
            claude: [
                claude({ id: `a`, label: `busy@example.com`, usage: usage(62) }),
                claude({ id: `b`, label: `spent@example.com`, usage: usage(94) }),
                claude({ id: `c`, label: `fresh@example.com`, usage: usage(8) }),
            ],
        };
        translatorAccounts.value = NO_ROUTED;

        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.rows.map((row) => row.label)).toEqual([`fresh@example.com`, `busy@example.com`]);
        expect([entry?.ready, entry?.total]).toEqual([2, 3]);
        // The count is what carries the spent one: 2 of 3 says a third exists without giving it a row.
        expect(chatCapacity(NOW).out).toEqual([]);
    });

    /* 90% is the boundary the whole app draws "effectively spent" at (SPENT_PERCENT), and the by-value
     * assertion is the point: a relational one ("89 is offered and 94 is not") still passes with the threshold
     * moved to 92, which would silently start offering accounts with a tenth of their week left. */
    it(`draws the line at the same 90% every other surface calls spent`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `edge`, usage: usage(89) })] };
        expect(chatCapacity(NOW).providers[0]?.rows[0]?.percent).toBe(89);

        providerAccounts.value = { claude: [claude({ id: `a`, label: `edge`, usage: usage(90) })] };
        expect(chatCapacity(NOW).providers).toEqual([]);
    });

    /* A plan that publishes no limits and one nobody has measured yet are both UNKNOWN, and unknown is not
     * exhausted: on a week where everything measurable is spent, these are the only accounts left, and a rail
     * that hid them would report a fleet with nothing in it. */
    it(`offers an account with no reading, and says which kind of nothing it has`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `unread` })] };
        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.rows[0]).toMatchObject({ percent: undefined, note: `no reading yet` });
    });
});

describe(`what cannot serve a turn, whatever its pools say`, () => {
    /* THE DEFECT THIS EXISTS TO PREVENT. An organization that switches the harness off for a seat changes
     * nothing else about the account: the token still authenticates and the usage endpoint still publishes
     * roomy pools, so the naive reading draws a confident 5% bar over the one account in the fleet that turns
     * every turn away. */
    it(`holds back the account a standing refusal names, however much room it reports`, () => {
        providerAccounts.value = {
            claude: [claude({ id: `a`, label: `turned-away`, usage: usage(5) }), claude({ id: `b`, label: `fine`, usage: usage(40) })],
        };
        providerRefusals.value = {
            claude: { at: NOW - 60_000, kind: `entitlement`, message: `Claude Code is not enabled for this account.`, account: `a` },
        };

        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.rows.map((row) => row.label)).toEqual([`fine`]);
    });

    /* A ROUTED refusal names nobody, and the silence is informative rather than missing: CLIProxyAPI picks the
     * auth file itself and only refuses once every credential it holds is cooling down. Read the other way
     * ("nobody named ⇒ nobody affected") this drew thirty-one green bars under a provider that had just
     * refused the reader's last turn.
     *
     * A WITHDRAWN PROJECT is the fixture because it is the case that needs this rule, and the only one that
     * isolates it. A spent-quota refusal already reads its own pool as full everywhere in the app
     * (usageStatus' spentByRefusal), so that pool drops off the list whether or not anything here understands
     * refusals at all — it would pass this test with the whole judgement deleted. An entitlement refusal pins
     * nothing: the pools stay roomy and go on being published forever, so the refusal is the only thing that
     * knows, which is exactly the state this guards. */
    it(`takes a whole routed pool off the list when its refusal names no account`, () => {
        translatorAccounts.value = { ...NO_ROUTED, gemini: [google(1, 4), google(2, 11)] };
        providerRefusals.value = {
            gemini: { at: NOW - 60_000, kind: `entitlement`, message: `Gemini for Google Cloud has not been enabled for this project.` },
        };

        const capacity = chatCapacity(NOW);
        expect(capacity.providers).toEqual([]);
        expect(capacity.out.map((entry) => entry.reason)).toEqual([`refused your last turn`]);
    });

    /* And a SPENT-QUOTA refusal reads as SPENT rather than as a refusal, which is not a near-miss on the word:
     * the plan said the pool was full, so the footnote gets to date its return instead of leaving the reader a
     * verb and no instant. The pin behind it is usageStatus', shared with every surface that draws one of these
     * numbers, so this rail cannot disagree with the composer about what "quota exceeded" meant. */
    it(`dates the return of a routed pool whose refusal was a spent quota`, () => {
        translatorAccounts.value = { ...NO_ROUTED, gemini: [google(1, 4)] };
        providerRefusals.value = { gemini: { at: NOW - 60_000, kind: `limit`, message: `Quota exceeded for this project.` } };

        const capacity = chatCapacity(NOW);
        expect(capacity.providers).toEqual([]);
        expect(capacity.out[0]).toMatchObject({ reason: `spent`, reopensAt: 1_700_003_600 });
    });

    it(`holds back a credential that can no longer be refreshed, and counts it where the fix is`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `expired`, usage: usage(3), needsReauth: true })] };
        const capacity = chatCapacity(NOW);
        expect(capacity.providers).toEqual([]);
        expect([capacity.needsReauth, capacity.out[0]?.reason]).toEqual([1, `sign-in expired`]);
    });
});

describe(`what the rail says about what it is not offering`, () => {
    /* An absent provider means two opposite things — spent until Sunday, or never connected — and the reader
     * cannot tell them apart from a list of offers alone. In a popped-out window there is no shell to go and
     * check in, which is exactly why the footnote exists. */
    it(`names a spent provider and the instant it comes back`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `spent`, usage: usage(96, 1_700_090_000) })] };
        expect(chatCapacity(NOW).out).toEqual([
            { provider: `claude`, label: `Claude Code`, reason: `spent`, reopensAt: 1_700_090_000, detail: undefined },
        ]);
    });

    /* THE 5-HOUR WINDOW IS NOT THE ANSWER TO "WHEN IS MY WEEK BACK". Every account publishes both, and the
     * short one reopens within the hour whether or not it is the pool that ran out — so reporting the soonest
     * reset of ALL pools promises a return the plan will not honour. Only a FULL pool's reset is a reopen. */
    it(`dates the return from the pool that is actually spent, not the soonest one on the account`, () => {
        providerAccounts.value = {
            claude: [
                claude({
                    id: `a`,
                    label: `spent`,
                    usage: {
                        measuredAt: NOW - 60_000,
                        windows: [
                            { kind: `five_hour`, utilization: 20, resetsAt: 1_700_003_600, gates: `all` },
                            { kind: `seven_day`, utilization: 97, resetsAt: 1_700_400_000, gates: `all` },
                        ],
                    },
                }),
            ],
        };
        expect(chatCapacity(NOW).out[0]?.reopensAt).toBe(1_700_400_000);
    });

    // A reset already in the past describes a pool that has reopened: sending someone to wait for it is worse
    // than saying nothing, because it is a wait that will never end.
    it(`offers no reopen instant when every spent pool's reset has already passed`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `spent`, usage: usage(96, Math.floor(NOW / 1000) - 60) })] };
        expect(chatCapacity(NOW).out[0]?.reopensAt).toBeUndefined();
    });
});

describe(`a pool nobody picks among`, () => {
    /* 31 Google sign-ins the translator balances turns across are ONE offer to a reader who cannot act on any
     * of them individually. Listing them would spend the whole column restating one fact per gmail address —
     * and it is the exact shape that made the flat account list on the Usage tab unreadable. */
    it(`stands a routed provider's whole pool in for by its roomiest reading`, () => {
        translatorAccounts.value = {
            ...NO_ROUTED,
            gemini: [google(1, 44), google(2, 4), google(3, 91), google(4, 30), google(5, 12)],
        };

        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.pooled).toBe(true);
        expect(entry?.rows).toHaveLength(1);
        // No name on the row: the address is not a choice, so printing one reads as "this account is what you
        // have". The count beside the heading is what says how deep the pool is.
        expect(entry?.rows[0]).toMatchObject({ label: undefined, percent: 4 });
        expect([entry?.ready, entry?.total, entry?.hidden]).toEqual([4, 5, 0]);
    });

    // Accounts the reader picks between by name get a row each, capped, and the cap says so rather than
    // trimming in silence.
    it(`caps a choosable list at three rows and counts the rest`, () => {
        providerAccounts.value = {
            claude: [1, 2, 3, 4, 5].map((index) => claude({ id: `a${index}`, label: `a${index}@example.com`, usage: usage(index * 5) })),
        };
        const [entry] = chatCapacity(NOW).providers;
        expect(entry?.rows.map((row) => row.label)).toEqual([`a1@example.com`, `a2@example.com`, `a3@example.com`]);
        expect(entry?.hidden).toBe(2);
    });

    // A lone account is already named by the heading above it, so its line is spent on the pool the figure came
    // from — which is the next thing worth knowing, and the thing the account name would have crowded out.
    it(`leaves a lone account's row unnamed and puts its binding pool on the line instead`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `only@example.com`, usage: usage(30) })] };
        expect(chatCapacity(NOW).providers[0]?.rows[0]).toMatchObject({ label: undefined, note: `Weekly · all models` });
    });
});

describe(`the order the providers are read in`, () => {
    it(`puts the roomiest provider first, and a provider with no reading behind every provider that has one`, () => {
        providerAccounts.value = { claude: [claude({ id: `a`, label: `claude`, usage: usage(70) })] };
        translatorAccounts.value = {
            ...NO_ROUTED,
            gemini: [google(1, 12)],
            // Grok publishes no limits at all: usable, unmeasurable, and not headroom.
            grok: [{ name: `grok-1`, label: `grok@example.com` }],
        };
        expect(chatCapacity(NOW).providers.map((entry) => entry.provider)).toEqual([`gemini`, `claude`, `grok`]);
    });
});

/* THE RAIL IS SPARE WIDTH OR IT IS NOTHING. The transcript stops widening at its reading measure, so past that
 * point a pane spends every extra pixel on centring — and that surplus, and only that surplus, is what the rail
 * is allowed to take. Asserted at the boundary by value: a relational test ("2000 fits and 900 does not") holds
 * with the threshold anywhere between, which is the whole thing worth pinning. */
describe(`when there is room for the rail`, () => {
    const LIST_RAIL = 320;
    // One pane's comfort width plus both rails: the narrowest panel that has anything to spare.
    const FITS = 872 + LIST_RAIL + CAPACITY_RAIL_PX;

    it(`yields the column only once no pane pays for it`, () => {
        expect(railFitsBeside(FITS, LIST_RAIL, 1)).toBe(true);
        expect(railFitsBeside(FITS - 1, LIST_RAIL, 1)).toBe(false);
    });

    // The chat list beside it is draggable, and a rule that assumed its default would hand the panes 160px less
    // than it promised to anyone who had widened it.
    it(`measures against the chat list's current width, not its default`, () => {
        expect(railFitsBeside(FITS, LIST_RAIL + 1, 1)).toBe(false);
    });

    // Two transcripts side by side want the width twice: a split that has only just fitted is not a window with
    // room to spare.
    it(`asks for the comfort width once per pane`, () => {
        expect(railFitsBeside(FITS + 872, LIST_RAIL, 2)).toBe(true);
        expect(railFitsBeside(FITS + 871, LIST_RAIL, 2)).toBe(false);
    });

    // The panel is measured, and until it has been the rail must not flash onto a window whose width is unread.
    it(`draws nothing before the panel has been measured`, () => {
        expect(railFitsBeside(0, LIST_RAIL, 1)).toBe(false);
    });

    /* WIDTH IS NOT THE ONLY QUESTION THE PANEL ASKS. It reserves the strip the rail stands in (--capacity-rail)
     * before anything is laid out, so an empty fleet has to be knowable up here: otherwise a sandbox with
     * nothing connected holds a rail's width of padding open down the side of a transcript for a column that
     * draws nothing at all.
     *
     * ROUTED CONNECTIONS COUNT. The obvious reading of "is anything connected" is the OAuth list, and this
     * sandbox's Gemini pool lives entirely in the other one — that reading reserves nothing for the fleet this
     * rail was built to report on. */
    it(`knows an empty fleet from one whose connections are all routed`, () => {
        expect(hasCapacity()).toBe(false);

        translatorAccounts.value = { ...NO_ROUTED, gemini: [google(1, 4)] };
        expect(hasCapacity()).toBe(true);

        translatorAccounts.value = NO_ROUTED;
        providerAccounts.value = { claude: [claude({ id: `a`, label: `one@example.com`, usage: usage(41) })] };
        expect(hasCapacity()).toBe(true);
    });
});
