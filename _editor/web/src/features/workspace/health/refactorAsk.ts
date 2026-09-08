import type { WorkspaceHotspot, WorkspaceKeyModule } from "@intentic/api-contract";
import { composeAsk, REFACTOR_INVARIANTS } from "@intentic/sandbox-contract/chores";
import type { ChurnWindow } from "./codebaseHealth";

// Which refactor a row's own figures call for, and what to say to the agent. Comparisons are leader-relative
// (a share of the top row), never an absolute threshold, and never surface as a grade, only wording.
//
// - churn and branching together: split along its change seams.
// - branching out of proportion: flatten it where it stands.
// - churn out of proportion (crowded, not tangled): split by subject.
// - also a key module (volatile and depended-on): separate the stable contract from the churn.
// - a wide key module: narrow the surface.
// - a test file (cost-to-work-in, not product risk): split by subject.

export type RefactorKind = "decompose" | "simplify" | "split" | "stabilize" | "tests" | "narrow";

export interface RefactorAsk {
    readonly kind: RefactorKind;
    // The tooltip: what the turn will be asked to do, since the button itself is only a glyph.
    readonly hint: string;
    // The turn, sent as an ordinary user message, so it lands in the transcript to read and argue with.
    readonly prompt: string;
    // True after a season untouched; not a refusal, since the payoff is in files edited again, so this steps back.
    readonly dormant: boolean;
}

// A share half again the other's counts as "out of proportion"; below that, churn and branching tell one story.
const DOMINANT = 1.5;
const DAY_MS = 86_400_000;
// Dormancy horizon: a quarter without a commit, reached only viewing all history (narrower windows exclude it).
const DORMANT_MS = 90 * DAY_MS;
// "Wide" is against peers in the same ranking, with a floor: a dozen-symbol module has no surface problem.
const WIDE_MULTIPLE = 3;
const WIDE_FLOOR = 20;

const TEST_FILE = /(\.(test|spec)\.[^./]+$|(^|\/)__tests__\/)/;

// Exact, never compacted (no "2.5M"), since a prompt quotes numbers the agent may recount.
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

// What each archetype asks for. Kept terse: the reader is a model about to act.
//
// - hint: speaks to the user, from a tooltip.
// - goal: what shape to move toward, never a design, since the agent reads the file first.
// - done: falsifiable; the agent can check it itself via `iq` in its own worktree.
const ARCHETYPE: Record<RefactorKind, { hint: string; diagnosis: string; goal: string; done: string }> = {
    decompose: {
        hint: `Split it along its change seams`,
        diagnosis: `It changes constantly and branches heavily, so every edit here is slow and easy to get wrong.`,
        goal: `Split it along its change seams, what gets edited together stays together, moving the branch-dense logic into single-purpose units with names of their own.`,
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
        diagnosis: `The churn is out of proportion to the branching: this file is not tangled, it is crowded, unrelated work keeps landing in one place.`,
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
        goal: `Split it by subject, one behaviour per file, and hoist repeated setup into shared fixtures. Do not change what is asserted; if an assertion looks wrong, say so instead of fixing it.`,
        done: `Done when the same tests pass, the same number of them run, and no assertion changed.`,
    },
    narrow: {
        hint: `Narrow its surface into modules by subject`,
        diagnosis: `Everything imports it because it holds everything, so unrelated changes queue behind each other here.`,
        goal: `Split it into modules by what each export is ABOUT, and repoint importers at the module that now owns what they use.`,
        done: `Done when what remains at that path exports only what belongs together, \`iq outline\` it to check, and the project's checks pass.`,
    },
};

// The four-part shape and refactor invariants live in @intentic/sandbox-contract/chores, shared with the
// Maintenance surface's chores. Local here is only which archetype a row calls for and what it asks.
const compose = (path: string, why: string, kind: RefactorKind): string => {
    const { diagnosis, goal, done } = ARCHETYPE[kind];
    return composeAsk({ subject: `Refactor ${path}.`, why, diagnosis, goal, invariants: REFACTOR_INVARIANTS, done: done.replace(`<path>`, path) });
};

// The same numbers the user is looking at, so the two are arguing about one set of facts.
const hotspotWhy = (hotspot: WorkspaceHotspot, rank: number, window: ChurnWindow): string =>
    `#${rank} hotspot in this repository: ${count(hotspot.commits)} commits ${WINDOW_PHRASE[window]}, +${count(hotspot.adds)}/-${count(hotspot.dels)} lines, ${count(hotspot.complexity)} branch points.`;

export interface HotspotContext {
    // 1-based position in the report; the ranking runs over every qualifying file, only the display is capped.
    readonly rank: number;
    readonly window: ChurnWindow;
    // Top row's figures; every share below is taken against these.
    readonly leader: { readonly commits: number; readonly complexity: number };
    // Whether this path also placed among key modules: volatile and depended-on at once.
    readonly keyModule: boolean;
    readonly nowMs: number;
}

// Which hotspot archetype a row is, in precedence order:
//
// - a test file: its numbers mean something else, no product reading applies.
// - depended-on (key module): outranks the shape of the file itself.
// - otherwise: the two signals' shares against the leader (the ordinary case).
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
            ? `Nothing has touched this in ${dormantFor(idle)}, a tangled file nobody edits costs nobody anything. Start an agent anyway: ${ARCHETYPE[kind].hint.toLowerCase()}.`
            : `Start an agent on it: ${ARCHETYPE[kind].hint.toLowerCase()}.`,
        prompt: compose(hotspot.path, hotspotWhy(hotspot, context.rank, context.window), kind),
        dormant,
    };
};

export interface ModuleContext {
    readonly rank: number;
    // Median exports across modules in the same ranking; the peer group this one is called wide against.
    readonly medianExports: number;
}

// An action only when the surface itself is the problem; a healthy chokepoint (few exports, many importers)
// at the top of PageRank is not a finding. Undefined leaves the row as a plain pointer.
export const moduleAsk = (module: WorkspaceKeyModule, context: ModuleContext): RefactorAsk | undefined => {
    if (module.exports < WIDE_FLOOR || module.exports < context.medianExports * WIDE_MULTIPLE) {
        return undefined;
    }
    const why = `#${context.rank} key module by PageRank: ${count(module.exports)} exports against a median of ${count(context.medianExports)} across that ranking.`;
    return {
        kind: `narrow`,
        hint: `Start an agent on it: ${ARCHETYPE.narrow.hint.toLowerCase()}.`,
        prompt: compose(module.path, why, `narrow`),
        // Churn isn't part of the import-graph ranking, so there's no age to step back from here.
        dormant: false,
    };
};
