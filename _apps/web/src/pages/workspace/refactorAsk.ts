import type { WorkspaceHotspot, WorkspaceKeyModule } from "@intentic-app/api-contract";
import { composeAsk, REFACTOR_INVARIANTS } from "@intentic/sandbox-contract/chores";
import type { ChurnWindow } from "./codebaseHealth";

/* WHICH REFACTOR THE NUMBERS CALL FOR — and what we say to the agent.
 *
 * The panel ranks files; this decides what to DO about the one the user picked. A row's own figures are enough
 * to tell the kinds apart, and they fail in different ways — one generic "clean this up" would be wrong for
 * most rows, and wrong in a way that costs a whole turn:
 *
 *   churn and branching together   a change magnet that is also tangled → split along its change seams
 *   branching out of proportion    tangled logic, rarely touched → flatten it where it stands
 *   churn out of proportion        not tangled, CROWDED: unrelated work keeps landing here → split by subject
 *   also a key module              volatile AND load-bearing → separate the stable contract from the churn
 *   a wide key module              everything imports it because it holds everything → narrow the surface
 *   a test file                    the figures are cost-to-work-in, not product risk → split by subject
 *
 * Every comparison is LEADER-RELATIVE, against the same list the user is reading — the trick hotspotRows uses
 * for its bars. Absolute thresholds would need tuning per repository and per language; a share of the top row
 * needs none. And none of it ever surfaces as a grade: it picks WORDING, nothing else.
 *
 * The user picks the row. These numbers never pick the file. */

export type RefactorKind = "decompose" | "simplify" | "split" | "stabilize" | "tests" | "narrow";

export interface RefactorAsk {
    readonly kind: RefactorKind;
    // The tooltip: what the turn will actually be asked to do, in the user's terms — the button itself is a
    // glyph, so this is the only place the archetype is legible before the turn starts.
    readonly hint: string;
    // The turn. Sent as an ordinary user message, so it lands in the transcript to be read and argued with.
    readonly prompt: string;
    // Nothing has touched the file in a season. Not a refusal — the user may know something the log doesn't —
    // but the panel's own thesis says the payoff is in files that get edited AGAIN, so the action steps back
    // rather than inviting the spend.
    readonly dormant: boolean;
}

// A share half again the other's is "out of proportion". Below that the two signals are telling one story
// (churn AND branching), which is the balanced case and its own archetype.
const DOMINANT = 1.5;
const DAY_MS = 86_400_000;
// The panel's own dormancy horizon: a quarter without a commit. Only reachable while viewing all of history —
// a narrower churn window has already excluded everything older than itself.
const DORMANT_MS = 90 * DAY_MS;
// A key module's surface is "wide" against its PEERS in the same ranking, with a floor: a module exporting a
// dozen symbols has no surface problem however it compares, and offering to split the repo's most load-bearing
// file for no reason is the worst invitation this panel could make.
const WIDE_MULTIPLE = 3;
const WIDE_FLOOR = 20;

const TEST_FILE = /(\.(test|spec)\.[^./]+$|(^|\/)__tests__\/)/;

// Exact, always — a prompt quotes numbers the agent may recount, so the panel's compacting formatter (which
// trades "2,450,000" for "2.5M" to fit a tile) is the wrong rule here.
const count = (value: number): string => value.toLocaleString(`en-US`);

const WINDOW_PHRASE: Record<ChurnWindow, string> = {
    all: `over all history`,
    "90d": `in the last 90 days`,
    "30d": `in the last 30 days`,
    "7d": `in the last 7 days`,
};

// Long enough that months stop being the unit a reader thinks in.
const dormantFor = (ms: number): string => {
    const months = Math.max(Math.round(ms / (30 * DAY_MS)), 1);
    return months >= 24 ? `${Math.round(months / 12)} years` : `${months} months`;
};

/* WHAT EACH ARCHETYPE ASKS FOR. Kept terse on purpose: the reader is a model about to act, and every sentence
 * past the load-bearing ones dilutes them — the rationale lives in this file, not in the prompt.
 *
 *   `hint` speaks to the user, from a tooltip on a dense row.
 *   `goal` is the only part that differs in kind: WHAT shape to move the file towards, never a design — the
 *          agent reads the file first, and a prescribed split from out here would be a guess.
 *   `done` is falsifiable, and deliberately something the agent can check itself: the same resident engine
 *          that ranked this row answers `iq` in the agent's own worktree, so it can recount rather than
 *          declare victory. */
const ARCHETYPE: Record<RefactorKind, { hint: string; diagnosis: string; goal: string; done: string }> = {
    decompose: {
        hint: `Split it along its change seams`,
        diagnosis: `It changes constantly and branches heavily, so every edit here is slow and easy to get wrong.`,
        goal: `Split it along its change seams — what gets edited together stays together — moving the branch-dense logic into single-purpose units with names of their own.`,
        done: `Done when \`iq hotspots --in <path>\` reports materially fewer branch points and the project's checks pass.`,
    },
    simplify: {
        hint: `Flatten its branching where it stands`,
        diagnosis: `Its branching is far out of proportion to how often it changes: the logic is tangled, not the file crowded.`,
        goal: `Flatten it where it stands: edge cases as early returns, compound conditions behind named predicates, long chains as lookups. Extract a unit only if a cohesive one falls out.`,
        done: `Done when \`iq hotspots --in <path>\` reports materially fewer branch points and the project's checks pass.`,
    },
    split: {
        hint: `Split it by responsibility, so changes stop colliding`,
        diagnosis: `The churn is out of proportion to the branching: this file is not tangled, it is crowded — unrelated work keeps landing in one place.`,
        goal: `Split it by responsibility so those changes stop colliding: one subject per file, each named for what it is FOR.`,
        done: `Done when every new file's subject takes one line to state and the project's checks pass.`,
    },
    stabilize: {
        hint: `Separate its stable contract from its churn`,
        diagnosis: `It churns like a hotspot and the rest of the repository imports it, so every edit here ripples outward.`,
        goal: `Separate the contract from the churn: a narrow, stable surface for importers to depend on, with the volatile implementation private behind it.`,
        done: `Done when the exported surface is smaller than what it hides, every importer reaches the true source, and the project's checks pass.`,
    },
    tests: {
        hint: `Split it by subject and hoist shared setup`,
        diagnosis: `It is a test file, so these figures are the cost of working in it rather than risk to the product.`,
        goal: `Split it by subject — one behaviour per file — and hoist repeated setup into shared fixtures. Do not change what is asserted; if an assertion looks wrong, say so instead of fixing it.`,
        done: `Done when the same tests pass, the same number of them run, and no assertion changed.`,
    },
    narrow: {
        hint: `Narrow its surface into modules by subject`,
        diagnosis: `Everything imports it because it holds everything, so unrelated changes queue behind each other here.`,
        goal: `Split it into modules by what each export is ABOUT, and repoint importers at the module that now owns what they use.`,
        done: `Done when what remains at that path exports only what belongs together — \`iq outline\` it to check — and the project's checks pass.`,
    },
};

/* The four-part shape (subject / why / goal / done) and the refactor invariants both live in @intentic/sandbox-contract/chores:
 * this panel's rows and the Maintenance surface's chores are the same move — a measurement turned into a turn —
 * and phrasing them two different ways would be two different products explaining themselves to the same reader.
 * What stays here is what is genuinely local: which archetype a row's own figures call for, and what each one asks
 * the agent to do about it. */
const compose = (path: string, why: string, kind: RefactorKind): string => {
    const { diagnosis, goal, done } = ARCHETYPE[kind];
    return composeAsk({ subject: `Refactor ${path}.`, why, diagnosis, goal, invariants: REFACTOR_INVARIANTS, done: done.replace(`<path>`, path) });
};

// What the row is ranked ON, in the agent's terms: the same numbers the user is looking at, so the two of them
// are arguing about one set of facts.
const hotspotWhy = (hotspot: WorkspaceHotspot, rank: number, window: ChurnWindow): string =>
    `#${rank} hotspot in this repository — ${count(hotspot.commits)} commits ${WINDOW_PHRASE[window]}, +${count(hotspot.adds)}/-${count(hotspot.dels)} lines, ${count(hotspot.complexity)} branch points.`;

export interface HotspotContext {
    // Position in the report — 1-based, and a real claim about the repository: the ranking is computed over
    // every qualifying file and only the DISPLAY is capped.
    readonly rank: number;
    readonly window: ChurnWindow;
    // The top row's figures, which every share below is taken against.
    readonly leader: { readonly commits: number; readonly complexity: number };
    // Whether this path also placed in the import graph's key modules — volatile and load-bearing at once.
    readonly keyModule: boolean;
    readonly nowMs: number;
}

/* Which of the hotspot archetypes this row is, in precedence order:
 *   a test file first — its numbers mean something else entirely, so no product-side reading of them applies;
 *   then load-bearing, because "who else depends on this" outranks the shape of the file itself;
 *   then the two signals' shares against the leader, which is the ordinary case. */
const hotspotKind = (hotspot: WorkspaceHotspot, context: HotspotContext): RefactorKind => {
    if (TEST_FILE.test(hotspot.path)) {
        return `tests`;
    }
    if (context.keyModule) {
        return `stabilize`;
    }
    const churn = context.leader.commits === 0 ? 0 : hotspot.commits / context.leader.commits;
    const branching = context.leader.complexity === 0 ? 0 : hotspot.complexity / context.leader.complexity;
    if (branching > churn * DOMINANT) {
        return `simplify`;
    }
    return churn > branching * DOMINANT ? `split` : `decompose`;
};

export const hotspotAsk = (hotspot: WorkspaceHotspot, context: HotspotContext): RefactorAsk => {
    const kind = hotspotKind(hotspot, context);
    const idle = context.nowMs - hotspot.latestMs;
    const dormant = idle > DORMANT_MS;
    return {
        kind,
        hint: dormant
            ? `Nothing has touched this in ${dormantFor(idle)} — a tangled file nobody edits costs nobody anything. Start an agent anyway: ${ARCHETYPE[kind].hint.toLowerCase()}.`
            : `Start an agent on it: ${ARCHETYPE[kind].hint.toLowerCase()}.`,
        prompt: compose(hotspot.path, hotspotWhy(hotspot, context.rank, context.window), kind),
        dormant,
    };
};

export interface ModuleContext {
    readonly rank: number;
    // Median exports across the modules in the same ranking — the peer group this one is called wide against.
    readonly medianExports: number;
}

/* A key module gets an action only when its SURFACE is the problem. The top of a PageRank ranking is where a
 * healthy chokepoint lives too — an `index.ts` exporting four symbols that everything imports is the shape you
 * want, not a finding — and a "refactor" offered on it would be this panel at its worst: a ranking laundered
 * into a to-do list. Undefined means the row stays what it was, a pointer at a file. */
export const moduleAsk = (module: WorkspaceKeyModule, context: ModuleContext): RefactorAsk | undefined => {
    if (module.exports < WIDE_FLOOR || module.exports < context.medianExports * WIDE_MULTIPLE) {
        return undefined;
    }
    const why = `#${context.rank} key module by PageRank — ${count(module.exports)} exports against a median of ${count(context.medianExports)} across that ranking.`;
    return {
        kind: `narrow`,
        hint: `Start an agent on it: ${ARCHETYPE.narrow.hint.toLowerCase()}.`,
        prompt: compose(module.path, why, `narrow`),
        // Churn is not in the import graph's ranking, so there is no age to step back from here.
        dormant: false,
    };
};
