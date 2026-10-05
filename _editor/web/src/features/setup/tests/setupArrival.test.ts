import type { SandboxSummary } from "@intentic/api-contract";
import { projectDirNameFor } from "@intentic/sandbox-contract";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { arrivalFor, type ArrivalInput, hostedIdle, projectPrefersHosted, resumedRow, rowToOpen, setupProjectOf, touched } from "../setupArrival";

// A blank first arrival on a platform offering everything; each test overrides the one field it is about.
const arrival = (over: Partial<ArrivalInput> = {}): ArrivalInput => ({
    inApp: false,
    onlySandbox: true,
    removedRecently: false,
    touched: false,
    hostedIdle: false,
    fresh: true,
    hostedOffered: true,
    hostedSpent: false,
    hostedFull: false,
    commandOffered: true,
    requestedMachine: undefined,
    elsewhere: false,
    project: false,
    hostedProjects: false,
    ...over,
});

describe(`the surface answers, not the reader`, () => {
    it(`starts a machine for a browser, and installs on the computer the app is running on`, () => {
        expect(arrivalFor(arrival())).toBe(`hosted`);
        expect(arrivalFor(arrival({ inApp: true }))).toBe(`local`);
    });

    it(`falls back to the picker when the surface's own answer cannot be taken`, () => {
        expect(arrivalFor(arrival({ hostedOffered: false }))).toBe(`choose`);
        expect(arrivalFor(arrival({ hostedSpent: true }))).toBe(`choose`);
        expect(arrivalFor(arrival({ inApp: true, commandOffered: false }))).toBe(`choose`);
    });
});

// "Add sandbox" pressed in the app by an account that already has one. Installing here is the whole gesture of
// having just installed the app, and nothing else: the second time, this computer is one of the places it could
// go rather than the only one.
describe(`a second sandbox asked for in the app`, () => {
    it(`asks instead of installing on this computer`, () => {
        expect(arrivalFor(arrival({ inApp: true, onlySandbox: false }))).toBe(`choose`);
    });

    it(`leaves the account's first one alone`, () => {
        expect(arrivalFor(arrival({ inApp: true, onlySandbox: true }))).toBe(`local`);
    });

    // The Billing page's own door: a subscriber's slot is a machine on the platform, never one more on this guest.
    it(`still starts the machine a link asked for by name`, () => {
        expect(arrivalFor(arrival({ inApp: true, onlySandbox: false, requestedMachine: `hosted` }))).toBe(`hosted`);
    });
});

// The reader removed the account's last sandbox. The empty account that leaves is not a first run: the app once
// installed a new sandbox by itself seconds after its reader removed the last one, folder sync ticked.
describe(`the arrival after a removal the reader made`, () => {
    it(`waits on the picker in the app and in a browser, starting nothing`, () => {
        expect(arrivalFor(arrival({ inApp: true, removedRecently: true }))).toBe(`choose`);
        expect(arrivalFor(arrival({ removedRecently: true }))).toBe(`choose`);
    });

    it(`still takes a rung the reader asked for by name, and a folder the app picked`, () => {
        expect(arrivalFor(arrival({ removedRecently: true, requestedMachine: `hosted` }))).toBe(`hosted`);
        expect(arrivalFor(arrival({ inApp: true, removedRecently: true, project: true }))).toBe(`local`);
    });
});

// Platform fleet is at its ceiling, distinct from this account's own `hostedSpent`; known here because this
// page starts a machine unasked.
describe(`a platform with no machines left`, () => {
    it(`shows the picker instead of starting one that cannot be started`, () => {
        expect(arrivalFor(arrival({ hostedFull: true }))).toBe(`choose`);
    });

    it(`ignores an explicit ask for a rung the platform cannot serve right now`, () => {
        expect(arrivalFor(arrival({ hostedFull: true, requestedMachine: `hosted` }))).toBe(`choose`);
    });

    it(`leaves the desktop app's own answer alone`, () => {
        expect(arrivalFor(arrival({ hostedFull: true, inApp: true }))).toBe(`local`);
    });
});

// A machine already on the row, nothing ever run on it: an earlier browser visit's own errand. The browser resumes
// it; the app is the gesture of installing on this computer, so it hands the machine back and goes local instead.
describe(`a row that already carries a machine`, () => {
    it(`is resumed in a browser and handed back in the app`, () => {
        expect(arrivalFor(arrival({ hostedIdle: true }))).toBe(`choose`);
        expect(arrivalFor(arrival({ hostedIdle: true, inApp: true }))).toBe(`local`);
    });

    it(`starts nothing more, however the machine was asked for`, () => {
        expect(arrivalFor(arrival({ hostedIdle: true, requestedMachine: `hosted` }))).toBe(`choose`);
        expect(arrivalFor(arrival({ hostedIdle: true, inApp: true, requestedMachine: `hosted` }))).toBe(`choose`);
    });

    it(`still needs an address to hand the app a code for`, () => {
        expect(arrivalFor(arrival({ hostedIdle: true, inApp: true, commandOffered: false }))).toBe(`choose`);
    });
});

it(`never acts on a resumed sandbox that something has happened to`, () => {
    expect(arrivalFor(arrival({ touched: true }))).toBe(`choose`);
    expect(arrivalFor(arrival({ touched: true, inApp: true }))).toBe(`choose`);
});

it(`starts a machine only for the row this arrival minted`, () => {
    expect(arrivalFor(arrival({ fresh: true }))).toBe(`hosted`);
    expect(arrivalFor(arrival({ fresh: false }))).toBe(`choose`);
});

it(`still honours an explicit ask on a row it found rather than made`, () => {
    expect(arrivalFor(arrival({ fresh: false, requestedMachine: `hosted` }))).toBe(`hosted`);
});

// An explicit rung chosen before this page (site's /where-it-runs cards) outranks the surface's own guess;
// re-deciding here would void the click.
describe(`an explicit ask`, () => {
    it(`is honoured over the surface's own answer`, () => {
        // `mine` in the app still lands on `choose`: the query surfaces the step instead of starting install silently.
        expect(arrivalFor(arrival({ inApp: true, requestedMachine: `mine` }))).toBe(`choose`);
        expect(arrivalFor(arrival({ requestedMachine: `hosted` }))).toBe(`hosted`);
    });

    it(`is ignored when the platform does not offer that rung`, () => {
        expect(arrivalFor(arrival({ requestedMachine: `hosted`, hostedOffered: false }))).toBe(`choose`);
    });
});

it(`shows the options rather than installing when the app says this computer cannot`, () => {
    expect(arrivalFor(arrival({ inApp: true, elsewhere: true }))).toBe(`choose`);
});

// The app opened this page for a folder on this computer, so the folder already answered where it runs: only the app
// can hand it to a sandbox, and on a platform from before hosted projects no machine of ours can hold it.
describe(`a project setup`, () => {
    it(`installs on this computer however many sandboxes the account has, and from a browser starts no machine`, () => {
        expect(arrivalFor(arrival({ project: true, inApp: true, onlySandbox: false }))).toBe(`local`);
        expect(arrivalFor(arrival({ project: true }))).toBe(`local`);
        expect(arrivalFor(arrival({ project: true, requestedMachine: `hosted` }))).toBe(`local`);
    });

    it(`still needs a code to hand the app, and leaves an errand in progress alone`, () => {
        expect(arrivalFor(arrival({ project: true, inApp: true, commandOffered: false }))).toBe(`choose`);
        expect(arrivalFor(arrival({ project: true, inApp: true, touched: true }))).toBe(`choose`);
        expect(arrivalFor(arrival({ project: true, inApp: true, elsewhere: true }))).toBe(`choose`);
    });
});

describe(`the folder a link names`, () => {
    it(`is the folder's own name, and where the sandbox puts it`, () => {
        expect(setupProjectOf(` My App `)).toEqual({ name: `My App`, dirName: projectDirNameFor(`My App`) });
    });

    it(`is no folder at all when blank, repeated or bare`, () => {
        expect([setupProjectOf(``), setupProjectOf(`   `), setupProjectOf([`a`, `b`]), setupProjectOf(null), setupProjectOf(undefined)]).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
        ]);
    });
});

describe(`the row an arrival settles on`, () => {
    const draft = sandboxSummary({ id: `draft` });
    const live = sandboxSummary({ id: `live`, lastSeenAt: `2026-09-23T10:00:00Z` });
    const shared = sandboxSummary({ id: `shared`, role: `writer`, token: null });

    it(`is the one the URL names, if it is the owner's`, () => {
        expect(rowToOpen([live, draft], `live`)?.id).toBe(`live`);
        expect(rowToOpen([shared, draft], `shared`)).toBe(undefined);
    });

    it(`is the account's one unfinished row while nothing it owns has ever run`, () => {
        expect(rowToOpen([draft], undefined)?.id).toBe(`draft`);
        expect(rowToOpen([live, draft], undefined)).toBe(undefined);
        expect(rowToOpen([draft], `gone`)?.id).toBe(`draft`);
    });

    it(`counts only genuine acts as history, and a machine nothing ran on as idle`, () => {
        const acted: SandboxSummary[] = [
            draft,
            live,
            { ...draft, setupCodeClaimedAt: `2026-09-23T10:00:00Z` },
            { ...draft, setupReport: { stage: `preflight`, failed: [], at: `2026-09-23T10:00:00Z` } },
        ];
        expect(acted.map(touched)).toEqual([false, true, true, true]);
        const machine = { region: `iad`, warm: true };
        expect([draft, { ...draft, hosted: machine }, { ...live, hosted: machine }].map(hostedIdle)).toEqual([false, true, false]);
    });
});

/* A PROJECT WHERE THE PLATFORM'S MACHINES CAN HOLD ONE (`hostedOffer.projects`). The desktop app's own ask runs on this
 * computer, beside the folder, and a machine of ours is one pick away; a project opened in a browser goes to a machine
 * of ours, which the app copies the folder into once it runs. Where no machine can be started, the folder goes to this
 * computer, as every project did before the platform's machines could hold one. */
describe(`a project where the platform's machines can hold one`, () => {
    const hostedProject = (over: Partial<ArrivalInput> = {}): ArrivalInput => arrival({ project: true, hostedProjects: true, inApp: true, ...over });

    // The owner's "Work on test-remove-me with an agent" landed on "Starting the machine, downloading your sandbox ... 3
    // to 5 minutes", for a folder on the computer the app runs on (2026-10-05).
    it(`runs on this computer when the app asks, beside another sandbox or not, and preselects no machine of ours`, () => {
        const asked = [{}, { onlySandbox: false }].map((over) => hostedProject(over));
        expect(asked.map(arrivalFor)).toEqual([`local`, `local`]);
        expect(asked.map(projectPrefersHosted)).toEqual([false, false]);
    });

    it(`starts a machine of ours in the app only when one is asked for by name`, () => {
        const named = hostedProject({ requestedMachine: `hosted` });
        expect({ arrival: arrivalFor(named), preselected: projectPrefersHosted(named) }).toEqual({ arrival: `hosted`, preselected: true });
    });

    it(`starts a machine for the row this visit made in a browser, beside another sandbox or not`, () => {
        const answers = [{ inApp: false }, { inApp: false, onlySandbox: false }].map((over) => arrivalFor(hostedProject(over)));
        expect(answers).toEqual([`hosted`, `hosted`]);
    });

    // A stale reload spends nothing, as a browser's does: the picker opens on the machine instead.
    it(`preselects the machine on a row it found rather than made, starting nothing`, () => {
        const found = hostedProject({ fresh: false, inApp: false });
        expect({ arrival: arrivalFor(found), preselected: projectPrefersHosted(found) }).toEqual({ arrival: `choose`, preselected: true });
        expect(arrivalFor({ ...found, requestedMachine: `hosted` })).toBe(`hosted`);
    });

    // In the app a machine on the row is otherwise handed back, since the app installs here; a project's is its own.
    it(`resumes a machine already on the row rather than handing it back`, () => {
        const resumed = [{ hostedIdle: true }, { hostedIdle: true, inApp: false }].map((over) => hostedProject(over));
        expect(resumed.map(arrivalFor)).toEqual([`choose`, `choose`]);
        expect(resumed.map(projectPrefersHosted)).toEqual([false, false]);
    });

    it(`goes to this computer when that is the rung asked for, a machine on the row or not`, () => {
        const asked = [{}, { hostedIdle: true }].map((over) => hostedProject({ requestedMachine: `mine`, ...over }));
        expect(asked.map(arrivalFor)).toEqual([`local`, `local`]);
        expect(asked.map(projectPrefersHosted)).toEqual([false, false]);
    });

    it.each<[string, Partial<ArrivalInput>]>([
        [`an allowance already spent`, { hostedSpent: true }],
        [`a full fleet`, { hostedFull: true }],
        [`a platform that hosts nothing`, { hostedOffered: false }],
    ])(`goes to this computer where no machine can be started, from a browser too: %s`, (_, over) => {
        for (const inApp of [true, false]) {
            const input = hostedProject({ ...over, inApp });
            expect({ arrival: arrivalFor(input), preselected: projectPrefersHosted(input) }).toEqual({ arrival: `local`, preselected: false });
        }
    });

    it(`still leaves an errand in progress alone, and needs a code to hand the app`, () => {
        const answers = [{ touched: true }, { elsewhere: true }, { hostedSpent: true, commandOffered: false }].map((over) =>
            arrivalFor(hostedProject(over)),
        );
        expect(answers).toEqual([`choose`, `choose`, `choose`]);
    });
});

describe(`a project where the platform's machines cannot hold one`, () => {
    it(`goes to this computer however it arrived, and preselects no machine of ours`, () => {
        const olderPlatform = [{}, { requestedMachine: `hosted` as const }, { hostedIdle: true }, { fresh: false }].map((over) =>
            arrival({ project: true, inApp: true, ...over }),
        );
        expect(olderPlatform.map(arrivalFor)).toEqual([`local`, `local`, `local`, `local`]);
        expect(olderPlatform.map(projectPrefersHosted)).toEqual([false, false, false, false]);
    });
});

// The line over a resumed row said the cleanup had cleared its container whenever the row had ever run: N read it,
// under a sign-in wall, about a sandbox that had answered a minute earlier.
describe(`what a resumed row is said to be`, () => {
    it(`is cleaned up only when its machine said it deleted the container`, () => {
        expect(resumedRow({ lastSeenAt: `2026-09-28T09:24:00Z`, removedAt: `2026-09-28T09:30:00Z` })).toBe(`removed`);
    });

    it(`is a sandbox that ran and was last seen, otherwise`, () => {
        expect(resumedRow({ lastSeenAt: `2026-09-28T09:24:00Z`, removedAt: null })).toBe(`seen`);
    });

    it(`is one that never ran when nothing ever reported`, () => {
        expect(resumedRow({ lastSeenAt: null, removedAt: null })).toBe(`never-ran`);
    });
});
