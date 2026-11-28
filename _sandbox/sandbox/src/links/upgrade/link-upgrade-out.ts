import { errorMessage } from "@intentic/base/errors";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { type ResolvedAddress, verifyIdentity } from "@intentic/sandbox-contract/s2s";
import type { LinkConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import { LINK_HEADER } from "@intentic/sandbox-contract/schemas/links";
import { type S2sGrants, S2sGrantsSchema, type S2sUpgradeAnswer } from "@intentic/sandbox-contract/schemas/s2s";
import type { Logger } from "pino";
import type { CapabilitiesStore } from "../../capabilities/capabilities-store.js";
import { fileVouched, readUpgradeAnswer, type UpgradeOutcome } from "../../s2s/contacts/contact-upgrade.js";
import type { ContactsCore } from "../../s2s/contacts/contacts.js";
import type { S2sFetch } from "../../s2s/messages/outbox.js";
import type { LinkedChildren } from "../linked-children.js";

// A LINK BECOMES A CONTACT, ON THE ASKING SIDE (docs/architecture/messages.md, "Across versions"; links.md). For a `link`
// card whose far sandbox answers `GET /s2s/identity`, this side posts its own document to `POST /link/upgrade` under the
// card's token, files the contact from the answer (named as the card was, so `mcp__<card>__…` keeps its name as the
// contact's tool server), moves every task handed over through the card onto the contact (the far side pushes their
// status from then on), and retires the card: removed, with its vaulted token. A far sandbox from before contacts is
// left as it is, the card working as before.

const UPGRADE_MS = 15_000;

/** What the holder of a link card lets the far side do: say things back, and wake it, so a task's report wakes a sleeping asker. */
export const LINK_ASKER_GRANTS: S2sGrants = S2sGrantsSchema.parse({ message: true, wake: true });

export interface LinkUpgradeOutDeps {
    readonly core: ContactsCore;
    readonly capabilities: Pick<CapabilitiesStore, "remove">;
    readonly children: Pick<LinkedChildren, "moveToContact">;
    readonly fetch: S2sFetch;
    readonly logger: Pick<Logger, "info" | "warn">;
}

// One link card as this side keeps it.
export interface LinkCard {
    readonly id: string;
    readonly config: LinkConfig;
}

const hostOf = (url: string): string | undefined => {
    try {
        return new URL(url).host;
    } catch {
        // allow(silent-catch): a card address that does not parse is no host, said as such by the caller.
        return undefined;
    }
};

// POST <card>/link/upgrade under the card's token, with this sandbox's document and wake secret.
const ask = async (deps: LinkUpgradeOutDeps, card: LinkCard): Promise<S2sUpgradeAnswer | UpgradeOutcome> => {
    const { core } = deps;
    try {
        const response = await deps.fetch(new URL(rawRouteUrl("POST /link/upgrade"), card.config.url).toString(), {
            method: "POST",
            headers: { "content-type": "application/json", [LINK_HEADER]: card.config.token },
            body: JSON.stringify({ document: await core.deps.identity().document(), grants: LINK_ASKER_GRANTS, wake: await core.deps.secrets.inbound() }),
            redirect: "error",
            signal: AbortSignal.timeout(UPGRADE_MS),
        });
        return await readUpgradeAnswer(response);
    } catch (error) {
        return { kind: "later", why: errorMessage(error) };
    }
};

// What the upgrade, run while the card's tasks are held still, came to.
interface Tried {
    outcome: UpgradeOutcome;
}

// The far side asked, and the contact filed here from its answer: the contact's id, or why not.
const fileFromAnswer = async (deps: LinkUpgradeOutDeps, card: LinkCard, resolved: Extract<ResolvedAddress, { ok: true }>): Promise<UpgradeOutcome> => {
    const answered = await ask(deps, card);
    if ("kind" in answered) {
        return answered;
    }
    if (answered.document.fingerprint !== resolved.document.fingerprint || !verifyIdentity(answered.document).ok) {
        return { kind: "refused", why: `"${card.id}" answered with a key its own address does not serve` };
    }
    const row = await fileVouched(deps.core, {
        address: resolved.address,
        document: resolved.document,
        scope: { kind: "sandbox" },
        grants: LINK_ASKER_GRANTS,
        theirGrants: answered.grants,
        wake: answered.wake,
        name: card.id,
        origin: "link-upgrade",
        // The card was paired from the owner's own editor, signed in to both, and the document at its address names it.
        vouchedSandbox: card.config.sandboxId,
    });
    return "refused" in row ? { kind: "refused", why: row.refused } : { kind: "upgraded", contact: row.id };
};

/** Upgrades one link card into a contact, or says why not; a far side from before contacts is left on the old path. */
export const upgradeLinkCard = async (deps: LinkUpgradeOutDeps, card: LinkCard): Promise<UpgradeOutcome> => {
    const host = hostOf(card.config.url);
    if (host === undefined || card.config.token === "") {
        return { kind: "refused", why: `the card "${card.id}" holds no address or token to upgrade with` };
    }
    const resolved = await deps.core.deps.resolve(host);
    if (!resolved.ok) {
        return resolved.code === "too_old" ? { kind: "old", why: resolved.message } : { kind: "later", why: resolved.message };
    }
    if (card.config.sandboxId !== undefined && resolved.document.sandbox !== card.config.sandboxId) {
        return { kind: "refused", why: `${host} serves the identity of ${resolved.document.sandbox}, not ${card.config.sandboxId}, the sandbox the card "${card.id}" was paired with` };
    }
    // Asked with the card's tasks held still, so none is read as gone while the far side moves it onto the contact.
    const tried: Tried = { outcome: { kind: "later", why: "the card's tasks could not be held still to upgrade it" } };
    const moved = await deps.children.moveToContact({ id: card.id, url: card.config.url }, async () => {
        tried.outcome = await fileFromAnswer(deps, card, resolved);
        return tried.outcome.kind === "upgraded" ? tried.outcome.contact : undefined;
    });
    const { outcome } = tried;
    if (outcome.kind === "upgraded") {
        await deps.capabilities.remove(card.id);
        deps.logger.info({ card: card.id, contact: outcome.contact, moved }, "link upgraded into a contact; its card is retired");
    }
    return outcome;
};
