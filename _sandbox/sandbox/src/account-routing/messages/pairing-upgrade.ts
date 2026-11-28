import { keyedLock } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { verifyIdentity } from "@intentic/sandbox-contract/s2s";
import { ROUTE_SECRET_HEADER, SANDBOX_PASS_HEADER, type SandboxPass } from "@intentic/sandbox-contract/sandbox-pass";
import { LINK_TURNS_PER_HOUR_DEFAULT } from "@intentic/sandbox-contract/schemas/links";
import {
    type S2sGrants,
    S2sGrantsSchema,
    type S2sUpgradeAnswer,
    S2sUpgradeRequestSchema,
    type S2sUpgradeRequest,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { Context } from "hono";
import type { Logger } from "pino";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { readBoundedJson } from "../../http/bounded-body.js";
import { opt } from "../../opt.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { type ConfirmRefusal, confirmAtAddress, postedDocumentProblem } from "../../s2s/contacts/contact-confirm.js";
import { fileVouched, readUpgradeAnswer, repeatedUpgrade, type UpgradeOutcome } from "../../s2s/contacts/contact-upgrade.js";
import type { ContactRefusal, ContactsCore } from "../../s2s/contacts/contacts.js";
import type { S2sFetch } from "../../s2s/messages/outbox.js";
import { type AdmitRoute, routeAdmissionOf } from "../admit-route.js";
import { filePairingsStore, type PairingsStore } from "../pairings-store.js";
import type { RouteAnswer } from "../route-client.js";
import type { RouteSecretsStore } from "../route-secrets.js";

// A ROUTE PAIRING BECOMES A PERSON-SCOPED CONTACT (docs/architecture/messages.md, "Across versions"; account-routing.md,
// "The pairing"). A route pairing is one person's leave for one sandbox to act as them in another: the platform's pass
// says who, the secret they minted there says they allowed it. Once both sandboxes speak s2s/1 that is exactly a
// person-scoped contact, so the sandbox holding the secret posts its identity document to
// `POST /account/pairings/upgrade` under a read pass and the secret; the other confirms the document at its own address
// (the handshake's rule), files the person's contact, and answers its own document, wake secret and grants. The asking
// side files its half from the answer and forgets the secret; the pairing there admits nothing any more. The old
// credential vouches for the new key exactly once: a repeat under it, for fifteen minutes and for the same key, reads the
// answer again and changes nothing; after that the secret opens no door at all.

// An identity document and room around it.
const BODY_MAX = 64 * 1024;
const UPGRADE_MS = 15_000;

/** What a person's route carried, as the contact's grants: their drops, reads and tasks, held to their floor at each use. */
export const PERSON_ROUTE_GRANTS: S2sGrants = S2sGrantsSchema.parse({
    message: true,
    task: { approve: false, turnsPerHour: LINK_TURNS_PER_HOUR_DEFAULT },
    records: true,
    wake: true,
});

/** What the sandbox that held the secret lets the other do over the person's contact: say things back, and wake it to. */
export const ROUTE_ASKER_GRANTS: S2sGrants = S2sGrantsSchema.parse({ message: true, wake: true });

/* THE TAKING SIDE: the sandbox the person minted the secret at. */

export interface PairingUpgradeInDeps {
    readonly core: ContactsCore;
    readonly pairings: Pick<PairingsStore, "markUpgraded" | "upgradedOf">;
    readonly now?: () => number;
}

type PairingAnswer = S2sUpgradeAnswer | ConfirmRefusal | ContactRefusal;

// The first upgrade of a pairing: the posted document the sandbox the pass names, confirmed at its own address, filed as
// the person's contact, and the pairing marked with it and the key it vouched for.
const firstUpgrade = async (deps: PairingUpgradeInDeps, pass: SandboxPass, person: string, request: S2sUpgradeRequest, at: number): Promise<PairingAnswer> => {
    const { core } = deps;
    const ours = await core.deps.identity().document();
    const problem =
        postedDocumentProblem(request.document, ours) ??
        (request.document.sandbox === pass.from
            ? undefined
            : ({ refused: `that identity is ${request.document.sandbox}, not ${pass.from}, the sandbox the pass names`, status: 403, code: "unconfirmed" } as const));
    if (problem !== undefined) {
        return problem;
    }
    const confirmed = await confirmAtAddress(core.deps.resolve, request.document);
    if ("refused" in confirmed) {
        return confirmed;
    }
    const row = await fileVouched(core, {
        ...confirmed,
        scope: { kind: "person", person: person.toLowerCase() },
        grants: PERSON_ROUTE_GRANTS,
        theirGrants: request.grants,
        wake: request.wake,
        name: pass.fromName,
        origin: "pairing-upgrade",
        vouchedSandbox: pass.from,
    });
    if ("refused" in row) {
        return row;
    }
    await deps.pairings.markUpgraded(pass.from, person, { contact: row.id, at, fingerprint: confirmed.document.fingerprint });
    const wake = row.grants.wake ? await core.deps.secrets.inbound() : undefined;
    if (wake !== undefined) {
        await core.handedWake(row.id);
    }
    return { contact: row.id, document: ours, grants: row.grants, ...opt("wake", wake) };
};

/**
 * One pairing's upgrade: the person's contact here and this sandbox's half, or why not. One at a time per pairing; once
 * upgraded, a repeat reads the same answer again for the same key and changes nothing (contact-upgrade.ts repeatedUpgrade).
 */
const pairingUpgradeIn = (deps: PairingUpgradeInDeps) => {
    const serialize = keyedLock<string>();
    const now = deps.now ?? Date.now;
    return async (pass: SandboxPass, person: string, request: S2sUpgradeRequest): Promise<PairingAnswer> =>
        serialize(`${pass.from}\u0000${person.toLowerCase()}`, async () => {
            const done = await deps.pairings.upgradedOf(pass.from, person);
            if (done === undefined) {
                return firstUpgrade(deps, pass, person, request, now());
            }
            const repeated = await repeatedUpgrade(deps.core, done, request.document, now());
            return repeated ?? { refused: "this pairing became a contact here longer ago than a repeat of its upgrade is answered: pair again", status: 409 };
        });
};

/** The door: a read pass beside the person's pairing secret (or the upgrade's own repeat), then the asker's document. */
export const pairingUpgradeRoute = (deps: PairingUpgradeInDeps, admit: AdmitRoute) => {
    const upgrade = pairingUpgradeIn(deps);
    return async (c: Context<AppEnv>): Promise<Response> => {
        const admitted = await admit(c, "read", { upgraded: true });
        if (admitted instanceof Response) {
            return admitted;
        }
        if (admitted.person === undefined) {
            return c.json({ error: "a pairing's upgrade is one person's: the pass names nobody", code: "not_member" }, 403);
        }
        const read = await readBoundedJson(c.req.raw, BODY_MAX);
        const parsed = read.kind === "ok" ? S2sUpgradeRequestSchema.safeParse(read.value) : undefined;
        if (parsed?.success !== true) {
            return c.json({ error: "an upgrade carries the asking sandbox's identity: {document, grants?, wake?}", code: "malformed" }, 400);
        }
        const answer = await upgrade(admitted.pass, admitted.person.email, parsed.data);
        if ("refused" in answer) {
            return c.json({ error: answer.refused, code: "code" in answer ? answer.code : "not_contact" }, answer.status);
        }
        return c.json(answer);
    };
};

export const pairingUpgradeRawRoutes = defineRawRoutes((services: Services) => ({
    "POST /account/pairings/upgrade": pairingUpgradeRoute({ core: services.s2s.core, pairings: filePairingsStore(services.config.historyRoot) }, routeAdmissionOf(services)),
}));

/* THE ASKING SIDE: the sandbox holding the secret. */

export interface PairingUpgradeOutDeps {
    readonly core: ContactsCore;
    readonly secrets: Pick<RouteSecretsStore, "secretFor" | "remove">;
    // Where the platform says the target is, with a read pass naming the person (route-client.ts routeTo).
    readonly locate: (target: string, person: string) => Promise<RouteAnswer>;
    readonly fetch: S2sFetch;
    readonly logger: Pick<Logger, "info" | "warn">;
}

const hostOfAddress = (address: string): string | undefined => {
    try {
        return new URL(address).host;
    } catch {
        // allow(silent-catch): an address that does not parse is no host, said as such by the caller.
        return undefined;
    }
};

/**
 * Upgrades the pairing this sandbox holds for routing as `person` into `target` (its tunnel id): the person's contact
 * filed here from the far answer, and the secret forgotten. A target from before contacts is left on the old path.
 */
export const upgradeRoutePairing = async (deps: PairingUpgradeOutDeps, held: { readonly target: string; readonly person: string }): Promise<UpgradeOutcome> => {
    const secret = await deps.secrets.secretFor(held.target, held.person);
    if (secret === undefined) {
        return { kind: "old", why: "no pairing is held for it" };
    }
    const located = await deps.locate(held.target, held.person);
    if (!located.ok) {
        return located.status === 0 || located.status >= 500 ? { kind: "later", why: located.message } : { kind: "refused", why: located.message };
    }
    const host = hostOfAddress(located.value.address);
    if (host === undefined) {
        return { kind: "refused", why: `the platform named no address for ${located.value.name}` };
    }
    const { core } = deps;
    const resolved = await core.deps.resolve(host);
    if (!resolved.ok) {
        return resolved.code === "too_old" ? { kind: "old", why: resolved.message } : { kind: "later", why: resolved.message };
    }
    if (resolved.document.sandbox !== held.target) {
        return { kind: "refused", why: `${host} serves the identity of ${resolved.document.sandbox}, not ${held.target}` };
    }
    let answered: S2sUpgradeAnswer | UpgradeOutcome;
    try {
        const response = await deps.fetch(new URL(rawRouteUrl("POST /account/pairings/upgrade"), located.value.address).toString(), {
            method: "POST",
            headers: { "content-type": "application/json", [SANDBOX_PASS_HEADER]: located.value.pass, [ROUTE_SECRET_HEADER]: secret },
            body: JSON.stringify({ document: await core.deps.identity().document(), grants: ROUTE_ASKER_GRANTS, wake: await core.deps.secrets.inbound() }),
            redirect: "error",
            signal: AbortSignal.timeout(UPGRADE_MS),
        });
        answered = await readUpgradeAnswer(response);
    } catch (error) {
        return { kind: "later", why: errorMessage(error) };
    }
    if ("kind" in answered) {
        return answered;
    }
    if (answered.document.fingerprint !== resolved.document.fingerprint || !verifyIdentity(answered.document).ok) {
        return { kind: "refused", why: `${located.value.name} answered with a key its own address does not serve` };
    }
    const row = await fileVouched(core, {
        address: resolved.address,
        document: resolved.document,
        scope: { kind: "person", person: held.person.toLowerCase() },
        grants: ROUTE_ASKER_GRANTS,
        theirGrants: answered.grants,
        wake: answered.wake,
        name: located.value.name,
        origin: "pairing-upgrade",
        // The platform said where the target is, and the document there names it (checked above).
        vouchedSandbox: held.target,
    });
    if ("refused" in row) {
        return { kind: "refused", why: row.refused };
    }
    await deps.secrets.remove(held.target, held.person);
    deps.logger.info({ target: held.target, person: held.person, contact: row.id }, "route pairing upgraded into a contact");
    return { kind: "upgraded", contact: row.id };
};
