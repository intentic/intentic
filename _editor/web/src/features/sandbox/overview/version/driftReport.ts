import { computed } from "vue";
import {
    advertisedRouteCount,
    comparedRouteCount,
    driftedRoutes,
    missingRoutes,
    ourRouteCount,
    unknownDaemonRoutes,
} from "../useDaemonRoutes";

// WHO IS FAILING TO TALK TO WHOM, in the words of someone who did not write the contract. The raw diff is three lists
// of dotted route names (`agent.send`, `sessions.list`); on its own it says "7 routes disagree", which names the
// mechanism and nothing else — not the two parties, not what breaks, not where the reader would notice. This turns it
// into the two sides of one conversation and a list of the product's own areas, each carrying its evidence.

// The three ways two builds fail to meet, worst first. They are genuinely different failures and no single sentence
// covers them: one call is absent, one is present with different fields, one exists on a side that can't ask for it.
export type DriftKind = "missing" | "drifted" | "extra";

// Ranked by how much of an area it takes away: an absent call is that feature gone here; a drifted one still answers
// and lies; an extra one costs nothing but an unused capability.
const KIND_RANK: Readonly<Record<DriftKind, number>> = { missing: 0, drifted: 1, extra: 2 };

export interface DriftArea {
    // Contract group the routes came from, which is also the row's key.
    readonly key: string;
    readonly label: string;
    // Where in the app the reader would be standing when this bites; a Row description, so one short line.
    readonly where: string;
    readonly missing: readonly string[];
    readonly drifted: readonly string[];
    readonly extra: readonly string[];
    // The worst kind this area holds, which decides its glyph and how the row is read.
    readonly kind: DriftKind;
    readonly count: number;
}

// Each contract group named as the product names it, with the screen it serves. Without this the card reports
// `agent` and `agents` as two things a reader is supposed to tell apart — a distinction only the contract makes.
// A group with no entry falls back to its own name: an unknown group means the OTHER side has a feature this build
// predates, so there is no honest label for it here.
const AREAS: Readonly<Record<string, { label: string; where: string }>> = {
    accounts: { label: `Accounts`, where: `the accounts this sandbox signs in as` },
    activity: { label: `Activity log`, where: `the audit feed of what the agent did` },
    agent: { label: `Running a turn`, where: `sending, stopping and following a turn` },
    agents: { label: `The fleet`, where: `the agent board and each agent's status` },
    approvals: { label: `Approvals`, where: `what the agent prepared for you to allow` },
    areas: { label: `Workspace areas`, where: `the named parts a member's reach is granted in` },
    automations: { label: `Automations`, where: `scheduled wake-ups and their approvals` },
    capabilities: { label: `Capabilities`, where: `connectors, accounts and the cards that grant them` },
    chores: { label: `Chores`, where: `maintenance runs and their evidence` },
    ci: { label: `CI`, where: `check runs and their results` },
    diff: { label: `Changes`, where: `the diff panel and file-by-file review` },
    endpoints: { label: `Model endpoints`, where: `the models this sandbox can call` },
    exit: { label: `Exit nodes`, where: `which country this sandbox's traffic leaves from` },
    extensions: { label: `Extensions`, where: `installed extensions and their views` },
    git: { label: `Git`, where: `branches, commits and what is staged` },
    history: { label: `History`, where: `the record of past conversations and turns` },
    intentic: { label: `Deployments`, where: `the intentic CLI's plan and apply runs` },
    inventory: { label: `Deploy inventory`, where: `what this workspace has and wants deployed` },
    issues: { label: `Issues`, where: `reported problems and their reports` },
    logs: { label: `Logs`, where: `the daemon's own log files` },
    loops: { label: `Loops`, where: `running and saved agent loops` },
    netdisk: { label: `Network disks`, where: `mounted network storage` },
    panels: { label: `Panels`, where: `the operator panels in the sidebar` },
    personas: { label: `Personas`, where: `the identities the agent speaks as` },
    ports: { label: `Ports`, where: `what this sandbox listens on, and previews` },
    prepush: { label: `Pre-push checks`, where: `what stands between a change and a push` },
    providers: { label: `AI providers`, where: `connected provider accounts` },
    public: { label: `Outbox`, where: `files published at the sandbox's public address` },
    push: { label: `Pushing`, where: `sending work to a repository` },
    safety: { label: `Safety policy`, where: `the policy document and what it decided` },
    secrets: { label: `Secrets`, where: `stored credentials and which are missing` },
    sessions: { label: `Conversations`, where: `the conversation list and its messages` },
    settings: { label: `Sandbox settings`, where: `everything on the Sandbox tabs` },
    share: { label: `Shared pages`, where: `conversations published as read-only pages` },
    skills: { label: `Skills`, where: `what the agent knows and what is switched on` },
    // Not "the sandbox itself": the party row two lines above is called "This sandbox", and one card cannot use that
    // word for both a side of the conversation and an area inside it.
    system: { label: `Sandbox internals`, where: `terminals, restarts, devices and sync` },
    translator: { label: `Subscriptions`, where: `routed-provider subscriptions` },
    usage: { label: `Usage`, where: `what each account has spent and what is left` },
    vpn: { label: `VPN`, where: `this sandbox's VPN connection` },
    workflows: { label: `Workflows`, where: `multi-agent workflow runs` },
    workspace: { label: `Files`, where: `the file tree, the editor and search` },
};

// A route name with no dot is its own group, not a hole in the list.
const groupOf = (route: string): string => route.split(`.`)[0] ?? route;

const nameOf = (key: string): { label: string; where: string } =>
    AREAS[key] ?? { label: key.charAt(0).toUpperCase() + key.slice(1), where: `a part of the app this page predates` };

// Folds three flat route lists into one row per area of the product. Pure, so the whole table above is testable
// without a daemon.
export const driftAreas = (lists: {
    missing: readonly string[];
    drifted: readonly string[];
    extra: readonly string[];
}): readonly DriftArea[] => {
    const byKey = new Map<string, { missing: string[]; drifted: string[]; extra: string[] }>();
    const file = (kind: DriftKind, routes: readonly string[]): void => {
        for (const route of routes) {
            const key = groupOf(route);
            const found = byKey.get(key) ?? { missing: [], drifted: [], extra: [] };
            found[kind].push(route);
            byKey.set(key, found);
        }
    };
    file(`missing`, lists.missing);
    file(`drifted`, lists.drifted);
    file(`extra`, lists.extra);

    return [...byKey.entries()]
        .map(([key, found]): DriftArea => {
            const kind: DriftKind = found.missing.length > 0 ? `missing` : found.drifted.length > 0 ? `drifted` : `extra`;
            return {
                key,
                ...nameOf(key),
                missing: found.missing.toSorted(),
                drifted: found.drifted.toSorted(),
                extra: found.extra.toSorted(),
                kind,
                count: found.missing.length + found.drifted.length + found.extra.length,
            };
        })
        // Worst kind first, then the areas most of which is affected; the label only breaks ties, so the order is
        // about consequence rather than alphabet.
        .toSorted((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.count - a.count || a.label.localeCompare(b.label));
};

export const driftedAreas = computed(() =>
    driftAreas({ missing: missingRoutes.value, drifted: driftedRoutes.value, extra: unknownDaemonRoutes.value }),
);

// What each kind COSTS, never what it is: the card's heading already says which disagreement this is, and a drawer
// that restates it spends the one place there was room to say what actually goes wrong.
export const KIND_IMPACT: Readonly<Record<DriftKind, string>> = {
    missing: `The sandbox answers these with a 404, so anything here that needs one fails outright until it catches up.`,
    drifted: `These answer, carrying fields this page doesn't expect: a value can come back blank, and a save can be rejected.`,
    extra: `This page has no name for these, so it never asks for them. Nothing breaks; you only miss what they offer.`,
};

// One word beside the count, so a mixed list can be read down its right edge without opening a row. The sentence
// each stands for is KIND_IMPACT, one chevron away.
export const KIND_TAG: Readonly<Record<DriftKind, string>> = { missing: `missing`, drifted: `differ`, extra: `extra` };

// `extra` is the one kind that costs nothing, so it is drawn as a remark rather than a warning; the other two are
// both a feature not working, loudly or silently.
export const KIND_TONE: Readonly<Record<DriftKind, "warning" | "info">> = { missing: `warning`, drifted: `warning`, extra: `info` };
export const KIND_BADGE: Readonly<Record<DriftKind, "warning" | "neutral">> = { missing: `warning`, drifted: `warning`, extra: `neutral` };

// A gap and a disagreement are not the same shape of failure, and the glyph says which before the words do:
// `arrows-h` for two sides pulling one call apart, a warning triangle for one that isn't there at all.
export const KIND_ICON: Readonly<Record<DriftKind, "exclamation-triangle" | "arrows-h" | "question-circle">> = {
    missing: `exclamation-triangle`,
    drifted: `arrows-h`,
    extra: `question-circle`,
};

// THE TWO PARTIES, as facts rather than as a verdict. Each side's own size is the scale a drift count is read
// against, and naming both is the answer to "which application can't talk to which".
export interface DriftParty {
    readonly icon: "window-maximize" | "box";
    readonly label: string;
    readonly what: string;
    // How many calls this side names; absent for a daemon that advertised none.
    readonly calls: number | undefined;
}

// A constant, not a computed: this side's contract is compiled into the bundle being read, so nothing about it can
// change while the page is open.
export const APP_PARTY: DriftParty = {
    icon: `window-maximize`,
    label: `This page`,
    what: `the editor, loaded in this browser tab`,
    calls: ourRouteCount,
};

export const sandboxParty = (where: string | undefined): DriftParty => ({
    icon: `box`,
    label: `This sandbox`,
    what: where === undefined ? `the daemon answering this page` : `the daemon answering this page, on ${where}`,
    calls: advertisedRouteCount.value,
});

// The disagreement as one measured line, which is what the two counts above are for: how many of the calls BOTH
// sides publish a shape for actually match. Undefined when neither side published enough to compare.
export const agreementLine = computed<string | undefined>(() => {
    const compared = comparedRouteCount.value;
    if (compared === 0) {
        return undefined;
    }
    const drifted = driftedRoutes.value.length;
    return `${compared - drifted} of ${compared} shared calls match`;
});
