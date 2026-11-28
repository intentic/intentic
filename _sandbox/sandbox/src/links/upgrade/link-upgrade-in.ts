import { keyedLock } from "@intentic/base/async";
import type { LinkTerms } from "@intentic/sandbox-contract/schemas/links";
import { type S2sGrants, S2sGrantsSchema, type S2sUpgradeAnswer, type S2sUpgradeRequest,type SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import { normalizeAddress } from "@intentic/sandbox-contract/s2s";
import { opt } from "../../opt.js";
import { type ConfirmRefusal, confirmAtAddress, postedDocumentProblem } from "../../s2s/contacts/contact-confirm.js";
import { fileVouched, repeatedUpgrade } from "../../s2s/contacts/contact-upgrade.js";
import type { ContactRefusal, ContactsCore } from "../../s2s/contacts/contacts.js";
import type { ContactTasksStore } from "../contacts/contact-tasks-store.js";
import type { InboundLinks, ResolvedLink } from "../inbound-links.js";
import { wakeLinkTaskStatus } from "../link-task-status-wait.js";

// A LINK BECOMES A CONTACT, ON THE TAKING SIDE (docs/architecture/messages.md, "Across versions"; links.md). The sandbox
// holding the link's card posts its identity document to `POST /link/upgrade` under the link's own token. The token says
// which sandbox asks; the key is the one its own address serves (contact-confirm.ts, the handshake's rule). This side
// files an accepted sandbox-scoped contact whose grants are the link's terms under their own names, moves every task the
// link filed onto the contact's book (links/contacts/), where its status is pushed as `task.update` messages from then on,
// answers its own document, wake secret and grants, and retires the token: the link's record stays, marked with the
// contact it became and the key it vouched for. The posted document must be the sandbox the link was minted for (its
// stored peer's id, and its host when the peer's address is known). The upgrade happens once: the retired token resolves
// at no door but this one, where for fifteen minutes it reads the same answer again for the same key, and changes nothing.

/** The grants a link's terms carry, under their own names: what the asking sandbox could do here over the link. */
export const grantsOfTerms = (terms: LinkTerms): S2sGrants =>
    S2sGrantsSchema.parse({
        message: true,
        ...opt("task", terms.tasks ? { ...opt("actsAs", terms.actsAs), ...opt("runAs", terms.runAs), approve: terms.approve, turnsPerHour: terms.turnsPerHour } : undefined),
        records: terms.records,
        operate: terms.operate,
        // A task to a sleeping sandbox started it over the link's door; a message to it does the same through the wake door.
        wake: true,
    });

export interface LinkUpgradeInDeps {
    readonly core: ContactsCore;
    readonly links: Pick<InboundLinks, "resolve" | "resolveUpgraded" | "upgrade">;
    readonly book: Pick<ContactTasksStore, "adopt">;
    readonly now?: () => number;
}

type Refused = ConfirmRefusal | ContactRefusal;

const hostOfUrl = (url: string): string | undefined => {
    try {
        return normalizeAddress(new URL(url).host);
    } catch {
        // allow(silent-catch): a peer address that does not parse binds nothing; its sandbox id still does.
        return undefined;
    }
};

/** Why the posted document is not the sandbox the link was minted for: another sandbox id, or another host. */
const peerProblem = (link: Pick<ResolvedLink, "from">, document: SandboxIdentity): ConfirmRefusal | undefined => {
    const peer = link.from;
    if (peer?.sandboxId !== undefined && peer.sandboxId !== document.sandbox) {
        return { refused: `that identity is ${document.sandbox}, not ${peer.sandboxId}, the sandbox this link was minted for`, status: 403, code: "unconfirmed" };
    }
    const host = peer?.url === undefined ? undefined : hostOfUrl(peer.url);
    if (host !== undefined && normalizeAddress(document.host) !== host && !document.domains.includes(host)) {
        return { refused: `that identity answers at ${document.host}, not at ${host}, where the sandbox this link was minted for is`, status: 403, code: "unconfirmed" };
    }
    return undefined;
};

// The asker's posted document, checked, bound to the link's peer, and confirmed at its own address.
const confirmedAsker = async (core: ContactsCore, link: ResolvedLink, request: S2sUpgradeRequest) => {
    const problem = postedDocumentProblem(request.document, await core.deps.identity().document()) ?? peerProblem(link, request.document);
    return problem ?? confirmAtAddress(core.deps.resolve, request.document);
};

// The link retired into the contact, and every task it filed moved onto the contact's book, each status pushed now as the
// contact's (links/contacts/task-push.ts hears the nudge), a settled one included, so a report the asking side had not
// read yet still reaches it.
const carryTasks = async (deps: LinkUpgradeInDeps, link: ResolvedLink, contact: string, fingerprint: string): Promise<void> => {
    const tasks = (await deps.links.upgrade(link.id, contact, fingerprint, (deps.now ?? Date.now)())) ?? [];
    await deps.book.adopt(contact, tasks);
    for (const task of tasks) {
        wakeLinkTaskStatus(task.conversationId);
    }
};

// What the door answers for a token it holds: the contact and this sandbox's half, why not, or `unknown` for a token it
// does not hold (never minted, revoked, or retired longer ago than a repeat is answered).
export type LinkUpgradeOutcome = S2sUpgradeAnswer | Refused | "unknown";

/**
 * One link's upgrade, under the token presented: its contact here and this sandbox's half, or why not. One at a time
 * per token, the link looked up again under the lock, so two racing asks upgrade it once.
 */
export const linkUpgradeIn = (deps: LinkUpgradeInDeps) => {
    const serialize = keyedLock<string>();
    const now = deps.now ?? Date.now;
    return async (presented: string, request: S2sUpgradeRequest): Promise<LinkUpgradeOutcome> =>
        serialize(presented, async () => {
            const { core } = deps;
            const retired = await deps.links.resolveUpgraded(presented);
            if (retired !== undefined) {
                return (await repeatedUpgrade(core, retired.upgraded, request.document, now())) ?? "unknown";
            }
            const link = await deps.links.resolve(presented);
            if (link === undefined) {
                return "unknown";
            }
            const at = await confirmedAsker(core, link, request);
            if ("refused" in at) {
                return at;
            }
            const row = await fileVouched(core, {
                ...at,
                scope: { kind: "sandbox" },
                grants: grantsOfTerms(link.terms),
                theirGrants: request.grants,
                wake: request.wake,
                name: link.label,
                origin: "link-upgrade",
                vouchedSandbox: link.from?.sandboxId,
            });
            if ("refused" in row) {
                return row;
            }
            await carryTasks(deps, link, row.id, at.document.fingerprint);
            const wake = row.grants.wake ? await core.deps.secrets.inbound() : undefined;
            if (wake !== undefined) {
                await core.handedWake(row.id);
            }
            return { contact: row.id, document: await core.deps.identity().document(), grants: row.grants, ...opt("wake", wake) };
        });
};
