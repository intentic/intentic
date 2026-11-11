import type { SandboxSummary } from "@intentic/api-contract";
import { type InboundLinkMint, LINK_TURNS_PER_HOUR_DEFAULT, type LinkTerms } from "@intentic/sandbox-contract/schemas/links";
import { loadContract } from "../client/sandbox/daemon/contract";
import { procedurePath } from "@intentic/sandbox-contract/protocol/routes";
import { RAW_JSON_ROUTES } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { timeAgo } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { z } from "zod";
import { sandboxJsonAt } from "../client/sandbox/sandboxClient";
import { SandboxHttpError } from "../client/sandbox/sandboxHttpError";

// PAIRING TWO OF THE READER'S SANDBOXES, done by this editor because it is the one party signed in to both: it mints the
// link on the sandbox that will take the tasks, under the reader's own session there, and hands the token to the form of
// the card on this one. The platform never sees the token; the far daemon keeps only its hash.

// What a link card's form is filled with once the far sandbox minted the link.
export interface PairedLink {
    // The card's id here: the agent's name for that sandbox.
    readonly id: string;
    readonly url: string;
    readonly token: string;
    readonly name: string;
    readonly sandboxId: string;
}

// The personas the far sandbox's tasks may wear, by id and name: all a pairing shows of them.
const PersonasAnswerSchema = z.object({ personas: z.array(z.object({ id: z.string(), label: z.string().optional() })) });
export type FarPersona = z.infer<typeof PersonasAnswerSchema>["personas"][number];

/** The far sandbox's personas, read as the reader there. */
export const personasAt = async (sandboxId: string): Promise<readonly FarPersona[]> =>
    (await sandboxJsonAt(sandboxId, procedurePath((await loadContract()).sandboxContract.personas.list), PersonasAnswerSchema)).personas;

/** A card id from a sandbox's name: what the agent hands work `to`, within a capability id's alphabet. */
export const linkCardId = (name: string): string => {
    const slug = name
        .toLowerCase()
        .normalize(`NFKD`)
        .replace(/[^a-z0-9_-]+/g, `-`)
        .replace(/^[-_]+|[-_]+$/g, ``)
        .slice(0, 60);
    return slug === `` ? `linked` : slug;
};

/**
 * The reader's other sandboxes a link may be minted on: one they operate (the far side's links are a maintainer's to
 * mint), with an address to reach it at, and not this one.
 */
export const pairableSandboxes = <Candidate extends { readonly id: string; readonly daemonUrl: string | null; readonly role: string }>(
    candidates: readonly Candidate[],
    here: string | undefined,
): (Candidate & { readonly daemonUrl: string })[] =>
    candidates.filter(
        (candidate): candidate is Candidate & { readonly daemonUrl: string } =>
            candidate.id !== here &&
            candidate.daemonUrl !== null &&
            candidate.daemonUrl !== `` &&
            (candidate.role === `owner` || candidate.role === `maintainer`),
    );

// The far sandbox an agent named when it asked for a link (`capabilities request link --target <it>`): by its name, the
// card id that name makes, its id, or its address. Undefined when nothing, or more than one, answers to it.
export const preferredSandbox = <Candidate extends { readonly id: string; readonly name: string; readonly daemonUrl: string | null }>(
    candidates: readonly Candidate[],
    prefer: string | undefined,
): Candidate | undefined => {
    const wanted = prefer?.trim().toLowerCase() ?? ``;
    if (wanted === ``) {
        return undefined;
    }
    const hostOf = (address: string): string => address.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, ``).replace(/[/:?#].*$/, ``);
    const matches = candidates.filter(
        (candidate) =>
            candidate.name.toLowerCase() === wanted ||
            linkCardId(candidate.name) === wanted ||
            candidate.id.toLowerCase() === wanted ||
            (candidate.daemonUrl !== null && candidate.daemonUrl !== `` && hostOf(candidate.daemonUrl) === hostOf(wanted)),
    );
    return matches.length === 1 ? matches[0] : undefined;
};

// What the picker says beside one of the reader's sandboxes: the machine it runs on, and whether it answers now. Read off
// the platform's row alone, since the far daemon is asked nothing until one is picked (its personas): a hosted machine
// says its own state, one on the reader's computer whether it sleeps there (and whether that computer can wake it), and
// any other when it last checked in, which it does at least hourly while it runs.
export type FarSandboxFacts = Pick<SandboxSummary, `hosted` | `hostReport` | `sleep` | `lastSeenAt`>;

const farMachine = (sandbox: FarSandboxFacts): string | undefined => {
    if (sandbox.hosted !== null) {
        return t(`capabilities.linkPairing.cloud`);
    }
    const machine = sandbox.hostReport?.machine.trim() ?? ``;
    return machine === `` ? undefined : machine;
};

// A hosted machine's own word for itself; `unknown`, or none from an older platform, says nothing.
const hostedState = (state: NonNullable<SandboxSummary[`hosted`]>[`state`]): string | undefined => {
    switch (state) {
        case `awake`:
            return t(`capabilities.linkPairing.awake`);
        case `asleep`:
            return t(`capabilities.linkPairing.asleep`);
        case `starting`:
            return t(`capabilities.linkPairing.starting`);
        case `down`:
            return t(`capabilities.linkPairing.down`);
        default:
            return undefined;
    }
};

const farState = (sandbox: FarSandboxFacts, now: number): string | undefined => {
    if (sandbox.hosted !== null) {
        return hostedState(sandbox.hosted.state);
    }
    if (sandbox.sleep !== null && sandbox.sleep !== undefined) {
        return sandbox.sleep.wakeable ? t(`capabilities.linkPairing.asleep`) : t(`capabilities.linkPairing.machineOff`);
    }
    return sandbox.lastSeenAt === null
        ? undefined
        : t(`capabilities.linkPairing.heard`, { ago: timeAgo(Date.parse(sandbox.lastSeenAt), { now, days: true }) });
};

/** The picker's note beside a sandbox's name: `rog · last heard 5 min ago`, `Intentic cloud · asleep`. */
export const farSandboxNote = (sandbox: FarSandboxFacts, now = Date.now()): string =>
    [farMachine(sandbox), farState(sandbox, now)].filter((part) => part !== undefined).join(` · `);

export interface PairAsk {
    readonly far: { readonly id: string; readonly name: string; readonly daemonUrl: string };
    readonly here: { readonly id: string | undefined; readonly name: string; readonly url: string | undefined };
    readonly terms: LinkTerms;
}

/**
 * Mints the link on the far sandbox, naming this one, and answers what the card here is filled with. A far daemon from
 * before links answers 404 for the route, which is said as what it is.
 */
export const pairWith = async ({ far, here, terms }: PairAsk, tooOld: string): Promise<PairedLink> => {
    const from: NonNullable<InboundLinkMint["from"]> = {};
    if (here.id !== undefined) {
        from.sandboxId = here.id;
    }
    if (here.url !== undefined) {
        from.url = here.url;
    }
    const mint: InboundLinkMint = { label: here.name, terms, from };
    try {
        const minted = await sandboxJsonAt(far.id, rawRouteUrl(`POST /system/links`), RAW_JSON_ROUTES[`POST /system/links`].output, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify(mint),
        });
        return { id: linkCardId(far.name), url: far.daemonUrl, token: minted.token, name: far.name, sandboxId: far.id };
    } catch (error) {
        if (error instanceof SandboxHttpError && error.status === 404) {
            throw new Error(tooOld, { cause: error });
        }
        throw error;
    }
};

// A task link: it takes tasks, shares no records until asked to, and lends no model accounts (an accounts link is minted
// on Sandbox ▸ Models, shareAccounts.ts).
export const DEFAULT_TERMS: LinkTerms = { approve: true, turnsPerHour: LINK_TURNS_PER_HOUR_DEFAULT, tasks: true, records: false, accounts: [] };
