import {
    type ConversationPrompt,
    REPO_CHECKS_FILE,
    type RepoChecksList,
    type SandboxHandlerOutput,
    type SavingsReport,
} from "@intentic/sandbox-contract";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { STARTED_AT } from "./roster";

// The Settings tab's records: the sandbox's settings, the system prompt a conversation opened with, the checks each
// repository declares, the safety policy, and what the tool-output cleaners saved.

// An empty rule table puts a finished agent in Ready to land, with nothing else deciding otherwise. One role is
// pinned to a provider with no credential here: a pin is written, not resolved, so "not connected" is a state the
// settings page has to be able to draw, and the only way to see it is to have one.
export const DEMO_SETTINGS: SandboxHandlerOutput<`settings`, `get`> = {
    rules: [],
    systemPromptMode: `intentic`,
    stableSystemPrompt: true,
    skills: [],
    modelRoles: { "commit-message": [{ provider: `gemini`, model: `gemini-3-1-pro` }] },
    // The two measured mechanisms are on with a holdout running, since their readout is the only place the
    // measurement block is drawn and an off switch hides it entirely.
    iqSearch: true,
    iqSearchHoldout: 0.1,
    workspaceMap: true,
    workspaceMapHoldout: 0.1,
    fieldNotes: true,
    fieldNotesBudget: 4000,
    fieldNotesHoldout: 0.2,
    toolResultClearing: true,
    toolResultClearingHoldout: 0.5,
};

// What a conversation was told before its first word. Every source at once, because the chip's whole job is to let a
// reader tell an arriving AGENTS.md from a dropped one, and a fixture with three of the four could not show that.
export const DEMO_SYSTEM_PROMPT: ConversationPrompt = {
    prompt: {
        at: STARTED_AT - 6 * 60_000,
        runtime: `claude-code`,
        mode: `intentic`,
        base: {
            kind: `intentic`,
            text: "You are an Intentic agent.\n\nYou work in one sandbox, on one workspace, for one person, and you finish what you are asked rather than reporting on how far you got.",
        },
        sections: [
            {
                source: `guidance`,
                title: `Working in this sandbox`,
                text: "## Working in this sandbox\n\nYou run inside Intentic, a sandbox serving one workspace from a browser editor. For anything about Intentic itself, load the `intentic` skill before answering.\n\nSearch code with `rg`, never `grep -r`, which walks node_modules.\n\nThe owner lands uncommitted work; commit only when asked.",
            },
            {
                source: `persona`,
                title: `Who this turn is acting as`,
                text: "## Who this turn is acting as\n\nYou are acting as **Studio**, which may read and write files and run commands, and reaches the `github` account alone.",
            },
            {
                source: `field-notes`,
                title: `Field notes for this sandbox`,
                text:
                    `## Field notes for this sandbox\n\nWritten 19 days ago from this sandbox's own record; ranks 1-5 of 12 are below.\n\n` +
                    `### Which tree you are standing in\n\n\`${WORKSPACE_ROOT}\` is the shared checkout every other agent is editing; your branch ` +
                    `is the worktree you were started in.\n\n### Toolchain\n\n\`pnpm\`'s exit code lies after a successful build here: ` +
                    `\`node_modules\` is an overlay mount and the hardlink sync fails across the device boundary. Read the build's own output, not the code.`,
            },
            {
                source: `memory`,
                title: `Standing instructions for this workspace`,
                text: "## Standing instructions for this workspace\n\n### AGENTS.md\n\n- No legacy support – make clean breaking changes; update all usages.\n- No migration logic – assume fresh state; remove compatibility layers.",
            },
        ],
    },
};

/* The checks each repository declares for itself (`<repo>/.intentic/checks.json`), one repository per state the group can be in: `web` running, `api` waiting on the owner, the workspace held since its file changed. Every one is an `edit` check, which is what most repositories declare; a `turn` check runs once as an isolated turn ends and says what it found back to the agent, and nothing runs after work lands any more, since CI checks what is pushed. */
export const DEMO_REPO_CHECKS: RepoChecksList = {
    repos: [
        {
            repo: `web`,
            path: `web/${REPO_CHECKS_FILE}`,
            checks: [{ when: `edit`, run: `pnpm exec eslint {file}`, paths: [`src/**`] }],
            fired: [Date.now() - 11 * 60_000],
            adopted: true,
            changed: false,
        },
        {
            repo: `api`,
            path: `api/${REPO_CHECKS_FILE}`,
            checks: [{ when: `edit`, run: `pnpm exec prettier --check {file}`, paths: [`src/**`] }],
            fired: [null],
            adopted: false,
            changed: false,
        },
        {
            repo: `root`,
            path: REPO_CHECKS_FILE,
            checks: [{ when: `edit`, run: `./scripts/check-headers.sh {file}`, paths: [`scripts/**`] }],
            fired: [null],
            adopted: false,
            changed: true,
        },
    ],
};

export const DEMO_SAFETY_POLICY = [
    `# Safety policy`,
    `How you should decide whether to stop and ask me before running something. You are judging one command at a time, and most of what reaches you is ordinary work a pattern match flagged by accident — a command that merely mentions a dangerous verb, a script being written to a file, a search whose pattern happens to look like a deletion. Allow those.`,
    `## In this sandbox`,
    `Everything under /work is a git worktree and everything in this container is disposable, so building, testing, editing, committing and deleting build output are all ordinary. Don't ask about them, however alarming the command looks in isolation.`,
    `Ask me before:`,
    `- publishing or releasing anything (npm publish, a GitHub release, a container push);\n- force-pushing or discarding commits that are not this turn's own work;\n- sending a credential anywhere outside this container.`,
    `## On my computers`,
    `A connected computer is not disposable and its files are not in any worktree. Ask before deleting anything there, before installing system packages, and before anything that touches a running service.`,
].join(`\n\n`);

// What the tool-output cleaners saved over the shown window, reported per-stage like the real product.
export const DEMO_SAVINGS: SavingsReport = {
    input: {
        updatedAt: STARTED_AT - 4 * 60_000,
        commands: 218,
        rawTokens: 1_284_600,
        emittedTokens: 402_140,
        savedPct: 68.7,
        perCleaner: [
            { id: `cap`, commands: 96, savedTokens: 553_700 },
            { id: `failtail`, commands: 41, savedTokens: 191_200 },
            { id: `cache`, commands: 81, savedTokens: 137_560 },
        ],
        holdout: { cleaned: 196, heldOut: 22, measuredSavedPct: 66.4 },
        gaps: [
            { command: `pnpm -C web build`, commands: 14, tokens: 41_200 },
            { command: `docker compose logs api`, commands: 6, tokens: 28_900 },
        ],
    },
    // The search teaching, in the state most of the block's surface has to draw: both arms past the threshold, the
    // margin measured, the effect still inside it. The second metric is the same subject read a second way.
    search: {
        minTurns: 60,
        sampleUnit: `conversations`,
        metrics: [
            { metric: `searchCalls`, on: { turns: 356, mean: 2.4 }, off: { turns: 111, mean: 2.6 }, marginPct: 19.5, controlTurnsNeeded: 312 },
            { metric: `openingSearches`, on: { turns: 356, mean: 1.1 }, off: { turns: 111, mean: 1.2 }, marginPct: 24.1 },
        ],
    },
    // The map has resolved on its headline and not on its second reading, so both verdict states are on screen at once.
    map: {
        minTurns: 60,
        sampleUnit: `conversations`,
        metrics: [
            {
                metric: `openingListings`,
                on: { turns: 355, mean: 0.6 },
                off: { turns: 100, mean: 1.7 },
                marginPct: 29.6,
                deltaPct: -63.7,
                saved: 388,
            },
            { metric: `callsBeforeTarget`, on: { turns: 355, mean: 5.2 }, off: { turns: 100, mean: 5.4 }, marginPct: 17.8, controlTurnsNeeded: 640 },
        ],
    },
    // The field notes in their third state, the one neither block above shows: not enough control conversations yet, so
    // both arms are reported and no claim is made. `cohort` is the revision in play, which is what a monthly rewrite
    // moves.
    notes: {
        minTurns: 30,
        sampleUnit: `conversations`,
        cohort: `a41f9c2e`,
        metrics: [
            { metric: `failedCalls`, on: { turns: 84, mean: 1.3 }, off: { turns: 21, mean: 2.1 } },
            { metric: `callsBeforeTarget`, on: { turns: 84, mean: 4.9 }, off: { turns: 21, mean: 5.1 } },
        ],
    },
    // Tool-result clearing as its simulation predicted it: the prompt per call resolved smaller, and the two readings of
    // what it could cost still inside their margins.
    clearing: {
        minTurns: 30,
        sampleUnit: `conversations`,
        metrics: [
            {
                metric: `contextPerCall`,
                on: { turns: 64, mean: 191_400 },
                off: { turns: 58, mean: 238_900 },
                marginPct: 9.6,
                deltaPct: -19.9,
            },
            { metric: `roundTrips`, on: { turns: 64, mean: 71.2 }, off: { turns: 58, mean: 68.5 }, marginPct: 21.4, controlTurnsNeeded: 210 },
            { metric: `failedCalls`, on: { turns: 64, mean: 1.9 }, off: { turns: 58, mean: 1.8 }, marginPct: 30.2 },
        ],
    },
};
