import { computed } from "vue";
import { appBehind, comparedRouteCount, daemonBehind, driftedRoutes, missingRoutes, unknownDaemonRoutes } from "../useDaemonRoutes";

// WHO IS FAILING TO TALK TO WHOM, IN WORDS SOMEONE WHO DID NOT WRITE THIS WOULD USE. The raw diff is three lists of
// dotted route names (`agent.send`, `sessions.list`), which on its own says "7 routes disagree" — a sentence about the
// mechanism and about nothing a reader can act on. Every string below is the plain-English half: what broke, what it
// will look like when it bites, and which part of the app it is in. The dotted names stay, one chevron away, for
// whoever goes and fixes it.
//
// No "route", "call", "endpoint", "contract", "schema" or "daemon" in anything a reader sees. Those are the words that
// made the first version of this card unreadable to everyone who had not written it.

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
    areas: { label: `Workspace areas`, where: `who is allowed to see which parts of the workspace` },
    automations: { label: `Automations`, where: `scheduled wake-ups and their approvals` },
    capabilities: { label: `Capabilities`, where: `connectors, accounts and the cards that grant them` },
    chores: { label: `Chores`, where: `maintenance runs and their evidence` },
    ci: { label: `CI`, where: `check runs and their results` },
    diff: { label: `Changes`, where: `the diff panel and file-by-file review` },
    endpoints: { label: `AI models`, where: `the models this sandbox is allowed to use` },
    exit: { label: `Exit nodes`, where: `which country this sandbox's traffic leaves from` },
    extensions: { label: `Extensions`, where: `installed extensions and their views` },
    git: { label: `Git`, where: `branches, commits and what is staged` },
    history: { label: `History`, where: `the record of past conversations and turns` },
    intentic: { label: `Deployments`, where: `deployment plans and the runs that apply them` },
    inventory: { label: `Deploy inventory`, where: `what this workspace has and wants deployed` },
    issues: { label: `Issues`, where: `reported problems and their reports` },
    logs: { label: `Logs`, where: `the sandbox's own log files` },
    loops: { label: `Loops`, where: `running and saved agent loops` },
    netdisk: { label: `Network disks`, where: `mounted network storage` },
    offload: { label: `Offloaded work`, where: `heavy commands sent to a runner on one of your machines` },
    panels: { label: `Panels`, where: `the operator panels in the sidebar` },
    personas: { label: `Personas`, where: `the identities the agent speaks as` },
    ports: { label: `Ports`, where: `what this sandbox listens on, and previews` },
    providers: { label: `AI accounts`, where: `the accounts your agents run on` },
    public: { label: `Outbox`, where: `files published at the sandbox's public address` },
    push: { label: `Pushing`, where: `sending work to a repository` },
    safety: { label: `Safety policy`, where: `the policy document and what it decided` },
    secrets: { label: `Secrets`, where: `stored credentials and which are missing` },
    sessions: { label: `Conversations`, where: `the conversation list and its messages` },
    settings: { label: `Sandbox settings`, where: `everything on the Sandbox tabs` },
    share: { label: `Shared pages`, where: `conversations published as read-only pages` },
    skills: { label: `Skills`, where: `what the agent knows and what is switched on` },
    // Named for what a reader would actually open, not for the group: "the sandbox itself" would collide with the
    // row above that IS the sandbox, and "internals" tells nobody which screen to distrust.
    system: { label: `Terminals and devices`, where: `terminals, restarts, devices and syncing` },
    translator: { label: `Subscriptions`, where: `AI plans you signed in to instead of paying per token` },
    usage: { label: `Usage`, where: `what each account has spent and what is left` },
    vpn: { label: `VPN`, where: `this sandbox's VPN connection` },
    workflows: { label: `Workflows`, where: `multi-agent workflow runs` },
    workspace: { label: `Files`, where: `the file tree, the editor and search` },
};

// A route name with no dot is its own group, not a hole in the list.
const groupOf = (route: string): string => route.split(`.`)[0] ?? route;

const nameOf = (key: string): { label: string; where: string } =>
    AREAS[key] ?? { label: key.charAt(0).toUpperCase() + key.slice(1), where: `something newer than this page` };

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

// What each kind COSTS, never what it is: the heading already says which disagreement this is, and a drawer that
// restates it spends the one place there was room to say what actually goes wrong.
export const KIND_IMPACT: Readonly<Record<DriftKind, string>> = {
    missing: `Your sandbox doesn't have this part yet, so anything here that needs it won't work until the sandbox catches up.`,
    drifted: `The two sides expect slightly different things here. You might see something come up empty, or a change that won't save.`,
    extra: `Your sandbox has this and this page is too old to use it. Nothing is broken — you just don't get it yet.`,
};

// What the badge says, so the list can be read down its right edge without opening anything. Each stands for one of
// the sentences above. Never a number: the number is how many internal endpoints are involved, which is a fact about
// the code and not about the reader's day.
export const KIND_TAG: Readonly<Record<DriftKind, string>> = { missing: `not available`, drifted: `may misbehave`, extra: `not used yet` };

// `extra` is the one kind that costs nothing, so it is drawn as a remark rather than a warning; the other two are
// both a feature not working, loudly or silently.
export const KIND_TONE: Readonly<Record<DriftKind, "warning" | "info">> = { missing: `warning`, drifted: `warning`, extra: `info` };
export const KIND_BADGE: Readonly<Record<DriftKind, "warning" | "neutral">> = { missing: `warning`, drifted: `warning`, extra: `neutral` };

// A gap and a disagreement are not the same shape of failure, and the glyph says which before the words do:
// `arrows-h` for two sides pulling one thing apart, a warning triangle for something that isn't there at all.
export const KIND_ICON: Readonly<Record<DriftKind, "exclamation-triangle" | "arrows-h" | "question-circle">> = {
    missing: `exclamation-triangle`,
    drifted: `arrows-h`,
    extra: `question-circle`,
};

// THE TWO SIDES, named the way a reader would point at them: one is the thing they are looking at, the other is the
// thing behind it. This pair is the answer to "which of these two can't talk to the other", which is the question the
// old card left entirely unanswered.
export interface DriftParty {
    readonly icon: "window-maximize" | "box";
    readonly label: string;
    readonly what: string;
    // `older` on the side that is behind, when anything proves which one is; never on both, and absent whenever the
    // evidence only shows a disagreement. A guess about which side is stale sends someone to restart the wrong one.
    readonly age: "older" | "newer" | undefined;
}

// Which side is behind, from the only two facts that prove it: a part one side has and the other has never heard of.
// Both directions at once is a fork, where neither is simply older, so neither row is marked.
const ages = (): { app: DriftParty["age"]; sandbox: DriftParty["age"] } => {
    if (daemonBehind.value && appBehind.value) {
        return { app: undefined, sandbox: undefined };
    }
    if (daemonBehind.value) {
        return { app: `newer`, sandbox: `older` };
    }
    return appBehind.value ? { app: `older`, sandbox: `newer` } : { app: undefined, sandbox: undefined };
};

export const appParty = (): DriftParty => ({
    icon: `window-maximize`,
    label: `This page`,
    what: `the editor you're looking at, in this browser tab`,
    age: ages().app,
});

export const sandboxParty = (where: string | undefined): DriftParty => ({
    icon: `box`,
    label: `Your sandbox`,
    what: where === undefined ? `the machine running your code` : `the machine running your code, on ${where}`,
    age: ages().sandbox,
});

// The only reassuring thing on the card, and worth saying: most of what these two do together is fine, so this is a
// few features misbehaving rather than a broken sandbox. Silent when the two sides never compared enough to know.
export const agreementLine = computed<string | undefined>(() =>
    comparedRouteCount.value === 0 ? undefined : `Everything else between them lines up.`,
);
