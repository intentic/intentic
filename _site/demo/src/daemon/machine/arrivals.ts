import type { RawJsonOutput } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import type { ArrivalHost, ArrivalItem, ArrivalPlan, ArrivalReport } from "@intentic/sandbox-contract/state/arrival";
import { refuse } from "@intentic/contract-serve";
import { pause } from "./machineKit";

// Setups moving into this sandbox (the daemon's migrations/): a plan read off an uploaded bundle or off a connected
// computer's own folders, held under its token until the owner applies the ticked rows or puts it away. One plan is held
// at a time, as the daemon holds one: reading another replaces it, and applying spends it.

// Reading a computer's folders over its socket, and unpacking what was ticked: a few seconds each, so they are watched.
const SCAN_MS = 2_400;
const APPLY_MS_PER_ITEM = 900;

// The owner's computers as the panel lists them: the PC answers and holds a Hermes setup; the Air is asleep.
export const arrivalHosts = (): ArrivalHost[] => [
    { id: `ada-pc::wsl:archlinux`, online: true, found: `hermes` },
    { id: `ada-air`, online: false, detail: `asleep since this morning: open its lid and check again` },
];

// The upload's checklist: one row per repo, one for workspace files, one for history, plus two steps the arrival can't
// do for the owner.
const bundlePlan = (token: string): ArrivalPlan => ({
    source: `bundle`,
    token,
    name: `acme-shop`,
    carriesSecrets: true,
    items: [
        {
            id: `bundle:files`,
            group: `files`,
            label: `Workspace files`,
            detail: `Everything in /work that is not one of the repositories below, and the workspace repo's own history — 4,213 files, 41.8 MB`,
            applicable: true,
            recommended: true,
            secrets: [`STRIPE_SECRET_KEY`],
        },
        { id: `repo:acme-shop`, group: `repo`, label: `Repository acme-shop`, detail: `Its working tree and its full git history — 1,904 files, 12.2 MB`, applicable: true, recommended: true, secrets: [] },
        {
            id: `repo:design-system`,
            group: `repo`,
            label: `Repository design-system`,
            detail: `Its working tree and its full git history — 22,610 files, 6.1 GB`,
            applicable: true,
            recommended: true,
            secrets: [],
        },
        {
            id: `bundle:history`,
            group: `history`,
            label: `Sandbox history`,
            detail: `Transcripts, checkpoint timelines and ledgers, the part nothing else can reproduce — 8,802 files, 310.4 MB`,
            applicable: true,
            recommended: true,
            secrets: [],
        },
    ],
    refused: [`history/session-secret (this sandbox does not accept identity files)`],
    needsAction: [
        {
            subject: `Rebuild the environment image`,
            detail: `The overlay Dockerfile travels, but the IMAGE it describes is built outside the container. Open the Environment card and run the rebuild command it shows.`,
        },
        {
            subject: `Reconnect capabilities`,
            detail: `Each connection arrives listed but unauthenticated. Open these on the Capabilities view and re-enter the credential each one asks for: github (git), linear (mcp).`,
        },
    ],
});

// What Hermes keeps on the PC, as its folders read: memory, two skills, a morning job, its Telegram bot and that bot's
// token, which moves only with the second consent.
const HERMES_ITEMS: ArrivalItem[] = [
    { id: `hermes:memory`, group: `memory`, label: `Memory, 38 notes`, detail: `Merged into the workspace's memory file under a "From Hermes" heading`, applicable: true, recommended: true, secrets: [] },
    { id: `hermes:skill:invoice-chaser`, group: `skill`, label: `Skill, invoice-chaser`, detail: `~/.hermes/skills/invoice-chaser`, applicable: true, recommended: true, secrets: [] },
    { id: `hermes:skill:weather`, group: `skill`, label: `Skill, weather`, applicable: false, reason: `this sandbox already has a skill called weather`, recommended: false, secrets: [] },
    {
        id: `hermes:cron:morning-brief`,
        group: `automation`,
        label: `Automation, morning brief`,
        detail: `Every weekday at 07:30, Europe/Warsaw: summarise the inbox and the day's calendar`,
        applicable: true,
        recommended: true,
        secrets: [],
    },
    { id: `hermes:capability:telegram`, group: `capability`, label: `Telegram bot @acme_ops_bot`, applicable: true, recommended: true, secrets: [] },
    { id: `hermes:secret:telegram`, group: `secret`, label: `Telegram bot token`, applicable: true, recommended: true, secrets: [`TELEGRAM_BOT_TOKEN`] },
];

const hermesPlan = (token: string): ArrivalPlan => ({
    source: `hermes`,
    token,
    name: `Hermes on ada-pc`,
    carriesSecrets: true,
    items: HERMES_ITEMS,
    refused: [`~/.hermes/sessions (conversations stay with Hermes)`, `~/.hermes/auth.json (an OAuth login is bound to the install that holds it)`],
    needsAction: [{ subject: `Point the bot at this sandbox`, detail: `Once the Telegram connection lands, stop Hermes on ada-pc so the bot answers from one place only.` }],
});

// The one plan held, and how many have been minted, so each token is new.
interface Held {
    plan: ArrivalPlan | undefined;
    minted: number;
}
const held: Held = { plan: undefined, minted: 0 };

const hold = (make: (token: string) => ArrivalPlan): ArrivalPlan => {
    held.minted += 1;
    held.plan = make(`arr_${held.minted.toString(36)}_${Date.now().toString(36)}`);
    return held.plan;
};

/** A plan read off an uploaded bundle; the bytes themselves are not read, any upload is the recording's bundle. */
export const planFromBundle = (): ArrivalPlan => hold(bundlePlan);

/** A plan read off a connected computer's folders, refused for one that is not there to read. */
export const planFromHost = async (host: string): Promise<ArrivalPlan> => {
    const found = arrivalHosts().find((candidate) => candidate.id === host);
    if (found?.online !== true) {
        return refuse(found === undefined ? `no connected device by that name` : `${host} is not answering right now`, 409);
    }
    await pause(SCAN_MS);
    return hold(hermesPlan);
};

/** Applies the ticked rows of the held plan, spending it; credentials move only with the second consent. */
export const applyArrival = async (token: string, ids: readonly string[], includeSecrets: boolean): Promise<ArrivalReport> => {
    const plan = held.plan;
    if (plan === undefined || plan.token !== token) {
        return refuse(`that plan is no longer held; read the setup again`, 409);
    }
    const ticked = plan.items.filter((item) => item.applicable && ids.includes(item.id));
    await pause(APPLY_MS_PER_ITEM * Math.max(1, ticked.length));
    held.plan = undefined;
    const withheld = ticked.filter((item) => item.group === `secret` && !includeSecrets);
    return {
        applied: ticked.filter((item) => !withheld.includes(item)).map((item) => ({ id: item.id, group: item.group, label: item.label })),
        failed: withheld.map((item) => ({ id: item.id, label: item.label, error: `a credential moves only when you agree to bring secrets too` })),
        refused: plan.refused,
        needsAction: plan.needsAction,
    };
};

/** Puts the held plan away; says whether there was one. */
export const abandonArrival = (): RawJsonOutput<`DELETE /arrivals`> => {
    const had = held.plan !== undefined;
    held.plan = undefined;
    return { ok: had };
};
