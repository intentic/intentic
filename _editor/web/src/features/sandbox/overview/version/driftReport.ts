import { t } from "@intentic/ui/i18n";
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
// predates, so there is no honest label for it here. Each entry reads the catalog when asked rather than at import,
// so a language switched after the page loaded names the areas in that language.
interface AreaName {
    readonly label: string;
    readonly where: string;
}
const AREAS: Readonly<Record<string, () => AreaName>> = {
    accounts: () => ({ label: t(`sandbox.driftReport.areas.accounts.label`), where: t(`sandbox.driftReport.areas.accounts.where`) }),
    activity: () => ({ label: t(`sandbox.driftReport.areas.activity.label`), where: t(`sandbox.driftReport.areas.activity.where`) }),
    agent: () => ({ label: t(`sandbox.driftReport.areas.agent.label`), where: t(`sandbox.driftReport.areas.agent.where`) }),
    agents: () => ({ label: t(`sandbox.driftReport.areas.agents.label`), where: t(`sandbox.driftReport.areas.agents.where`) }),
    approvals: () => ({ label: t(`sandbox.driftReport.areas.approvals.label`), where: t(`sandbox.driftReport.areas.approvals.where`) }),
    areas: () => ({ label: t(`sandbox.driftReport.areas.areas.label`), where: t(`sandbox.driftReport.areas.areas.where`) }),
    automations: () => ({ label: t(`sandbox.driftReport.areas.automations.label`), where: t(`sandbox.driftReport.areas.automations.where`) }),
    capabilities: () => ({ label: t(`sandbox.driftReport.areas.capabilities.label`), where: t(`sandbox.driftReport.areas.capabilities.where`) }),
    chores: () => ({ label: t(`sandbox.driftReport.areas.chores.label`), where: t(`sandbox.driftReport.areas.chores.where`) }),
    ci: () => ({ label: t(`sandbox.driftReport.areas.ci.label`), where: t(`sandbox.driftReport.areas.ci.where`) }),
    diff: () => ({ label: t(`sandbox.driftReport.areas.diff.label`), where: t(`sandbox.driftReport.areas.diff.where`) }),
    endpoints: () => ({ label: t(`sandbox.driftReport.areas.endpoints.label`), where: t(`sandbox.driftReport.areas.endpoints.where`) }),
    exit: () => ({ label: t(`sandbox.driftReport.areas.exit.label`), where: t(`sandbox.driftReport.areas.exit.where`) }),
    extensions: () => ({ label: t(`sandbox.driftReport.areas.extensions.label`), where: t(`sandbox.driftReport.areas.extensions.where`) }),
    git: () => ({ label: t(`sandbox.driftReport.areas.git.label`), where: t(`sandbox.driftReport.areas.git.where`) }),
    history: () => ({ label: t(`sandbox.driftReport.areas.history.label`), where: t(`sandbox.driftReport.areas.history.where`) }),
    intentic: () => ({ label: t(`sandbox.driftReport.areas.intentic.label`), where: t(`sandbox.driftReport.areas.intentic.where`) }),
    inventory: () => ({ label: t(`sandbox.driftReport.areas.inventory.label`), where: t(`sandbox.driftReport.areas.inventory.where`) }),
    issues: () => ({ label: t(`sandbox.driftReport.areas.issues.label`), where: t(`sandbox.driftReport.areas.issues.where`) }),
    logs: () => ({ label: t(`sandbox.driftReport.areas.logs.label`), where: t(`sandbox.driftReport.areas.logs.where`) }),
    loops: () => ({ label: t(`sandbox.driftReport.areas.loops.label`), where: t(`sandbox.driftReport.areas.loops.where`) }),
    needs: () => ({ label: t(`sandbox.driftReport.areas.needs.label`), where: t(`sandbox.driftReport.areas.needs.where`) }),
    netdisk: () => ({ label: t(`sandbox.driftReport.areas.netdisk.label`), where: t(`sandbox.driftReport.areas.netdisk.where`) }),
    offload: () => ({ label: t(`sandbox.driftReport.areas.offload.label`), where: t(`sandbox.driftReport.areas.offload.where`) }),
    panels: () => ({ label: t(`sandbox.driftReport.areas.panels.label`), where: t(`sandbox.driftReport.areas.panels.where`) }),
    personas: () => ({ label: t(`sandbox.driftReport.areas.personas.label`), where: t(`sandbox.driftReport.areas.personas.where`) }),
    ports: () => ({ label: t(`sandbox.driftReport.areas.ports.label`), where: t(`sandbox.driftReport.areas.ports.where`) }),
    providers: () => ({ label: t(`sandbox.driftReport.areas.providers.label`), where: t(`sandbox.driftReport.areas.providers.where`) }),
    public: () => ({ label: t(`sandbox.driftReport.areas.public.label`), where: t(`sandbox.driftReport.areas.public.where`) }),
    push: () => ({ label: t(`sandbox.driftReport.areas.push.label`), where: t(`sandbox.driftReport.areas.push.where`) }),
    safety: () => ({ label: t(`sandbox.driftReport.areas.safety.label`), where: t(`sandbox.driftReport.areas.safety.where`) }),
    secrets: () => ({ label: t(`sandbox.driftReport.areas.secrets.label`), where: t(`sandbox.driftReport.areas.secrets.where`) }),
    sessions: () => ({ label: t(`sandbox.driftReport.areas.sessions.label`), where: t(`sandbox.driftReport.areas.sessions.where`) }),
    settings: () => ({ label: t(`sandbox.driftReport.areas.settings.label`), where: t(`sandbox.driftReport.areas.settings.where`) }),
    share: () => ({ label: t(`sandbox.driftReport.areas.share.label`), where: t(`sandbox.driftReport.areas.share.where`) }),
    skills: () => ({ label: t(`sandbox.driftReport.areas.skills.label`), where: t(`sandbox.driftReport.areas.skills.where`) }),
    // Named for what a reader would actually open, not for the group: "the sandbox itself" would collide with the
    // row above that IS the sandbox, and "internals" tells nobody which screen to distrust.
    system: () => ({ label: t(`sandbox.driftReport.areas.system.label`), where: t(`sandbox.driftReport.areas.system.where`) }),
    translator: () => ({ label: t(`sandbox.driftReport.areas.translator.label`), where: t(`sandbox.driftReport.areas.translator.where`) }),
    usage: () => ({ label: t(`sandbox.driftReport.areas.usage.label`), where: t(`sandbox.driftReport.areas.usage.where`) }),
    vpn: () => ({ label: t(`sandbox.driftReport.areas.vpn.label`), where: t(`sandbox.driftReport.areas.vpn.where`) }),
    workflows: () => ({ label: t(`sandbox.driftReport.areas.workflows.label`), where: t(`sandbox.driftReport.areas.workflows.where`) }),
    workspace: () => ({ label: t(`sandbox.driftReport.areas.workspace.label`), where: t(`sandbox.driftReport.areas.workspace.where`) }),
};

// A route name with no dot is its own group, not a hole in the list.
const groupOf = (route: string): string => route.split(`.`)[0] ?? route;

const nameOf = (key: string): AreaName =>
    AREAS[key]?.() ?? { label: key.charAt(0).toUpperCase() + key.slice(1), where: t(`sandbox.driftReport.unknownWhere`) };

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
const KIND_IMPACT: Readonly<Record<DriftKind, () => string>> = {
    missing: () => t(`sandbox.driftReport.impact.missing`),
    drifted: () => t(`sandbox.driftReport.impact.drifted`),
    extra: () => t(`sandbox.driftReport.impact.extra`),
};
export const kindImpact = (kind: DriftKind): string => KIND_IMPACT[kind]();

// What the badge says, so the list can be read down its right edge without opening anything. Each stands for one of
// the sentences above. Never a number: the number is how many internal endpoints are involved, which is a fact about
// the code and not about the reader's day.
const KIND_TAG: Readonly<Record<DriftKind, () => string>> = {
    missing: () => t(`sandbox.driftReport.tag.missing`),
    drifted: () => t(`sandbox.driftReport.tag.drifted`),
    extra: () => t(`sandbox.driftReport.tag.extra`),
};
export const kindTag = (kind: DriftKind): string => KIND_TAG[kind]();

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
    label: t(`sandbox.driftReport.appLabel`),
    what: t(`sandbox.driftReport.appWhat`),
    age: ages().app,
});

export const sandboxParty = (where: string | undefined): DriftParty => ({
    icon: `box`,
    label: t(`sandbox.driftReport.sandboxLabel`),
    what: where === undefined ? t(`sandbox.driftReport.sandboxWhat`) : t(`sandbox.driftReport.sandboxWhatOn`, { where }),
    age: ages().sandbox,
});

// The only reassuring thing on the card, and worth saying: most of what these two do together is fine, so this is a
// few features misbehaving rather than a broken sandbox. Silent when the two sides never compared enough to know.
// A full row, not a one-line note: it answers the same question as the rows around it (which parts, and how they are).
export const agreementLine = computed<{ label: string; what: string } | undefined>(() =>
    comparedRouteCount.value === 0
        ? undefined
        : { label: t(`sandbox.driftReport.agreementLabel`), what: t(`sandbox.driftReport.agreementWhat`) },
);
