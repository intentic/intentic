import { join } from "node:path";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { EnvironmentOffer } from "@intentic/sandbox-contract";
import { draftFileName } from "./auto-drafts.js";
import { renderBlocks, splitBlocks, uniqueBlocks } from "./overlay-blocks.js";
import type { RuntimeInstallsStore } from "./runtime-installs.js";
import { statePath } from "../state-paths.js";

// Drafts the daemon writes on its own (a recurring runtime install, a cache-rule revision of an approved block) are
// remembered until they are answered, so one that disappears WITHOUT an answer reads as the no it was. The Changes
// panel's discard, a `git clean`, or deleting the file by hand are how a person most naturally turns a file down, and
// none of them goes through the Environment card: the sweep used to find the draft missing, nothing on record against
// it, and write it straight back ten minutes later, along with the proposal composed from it.

interface OfferDeps {
    readonly workspace: { readonly root: string };
    readonly files: {
        readonly read: (path: string) => Promise<string | undefined>;
        readonly write: (path: string, content: string) => Promise<void>;
        readonly remove: (path: string) => Promise<void>;
    };
    readonly runtimeInstalls: Pick<RuntimeInstallsStore, "read" | "offer" | "withdrawOffers" | "settle" | "decline">;
}

const draftsDirOf = (root: string): string => statePath(root, ".intentic/config/environment.d/");
const customPathOf = (root: string): string => statePath(root, ".intentic/config/environment.custom.Dockerfile");
const proposalPathOf = (root: string): string => statePath(root, ".intentic/config/environment.Dockerfile");

// Remembers the drafts just written under these names; `install` names the ledger entry an auto-draft came from.
export const offerDrafts = async (deps: OfferDeps, written: readonly { readonly block: string; readonly install?: string }[], at: number): Promise<void> => {
    const offers: EnvironmentOffer[] = [];
    for (const entry of written) {
        const file = draftFileName(entry.block);
        const body = file === undefined ? undefined : (await deps.files.read(join(draftsDirOf(deps.workspace.root), file)))?.trim();
        if (file === undefined || body === undefined || body === "") {
            continue;
        }
        offers.push({ tool: file.slice(0, -".Dockerfile".length), hash: sha256Hex(body), at, ...(entry.install === undefined ? {} : { install: entry.install }) });
    }
    await deps.runtimeInstalls.offer(offers);
};

// The proposal composed while the draft stood still carries its block; without it, the card would go on asking for the
// steps the owner just threw away. What remains stays proposed; a proposal asking nothing beyond the custom section goes.
const dropFromProposal = async (deps: OfferDeps, block: string): Promise<void> => {
    const path = proposalPathOf(deps.workspace.root);
    const proposal = await deps.files.read(path);
    if (proposal === undefined) {
        return;
    }
    const proposed = uniqueBlocks(splitBlocks(proposal.trim()));
    if (!proposed.some((entry) => entry.name === block)) {
        return;
    }
    const rest = renderBlocks(proposed.filter((entry) => entry.name !== block));
    const custom = renderBlocks(uniqueBlocks(splitBlocks(((await deps.files.read(customPathOf(deps.workspace.root))) ?? "").trim())));
    if (rest === "" || rest === custom) {
        await deps.files.remove(path);
        return;
    }
    await deps.files.write(path, `${rest}\n`);
};

// Reads every outstanding offer against what is on disk and on record, before the sweep drafts anything:
//   - its file still holds exactly what was offered: still waiting, kept;
//   - its file holds something else: a person (or an agent) rewrote it, so it is theirs now, and forgotten;
//   - its file is gone and the answer is on record (approved into the custom section, settled by an approve, reject or
//     removal, or its install declined from the card): forgotten, the record already speaks;
//   - its file is gone with no answer anywhere: thrown away by hand, and read as a no. An auto-draft's install is
//     declined, which the drafter honours; a revision is settled under its hash, which the reviser honours. Either way
//     the proposal stops asking for it.
// Returns the blocks read as declined, for the sweep's log line.
export const reconcileOffers = async (deps: OfferDeps, at: number): Promise<string[]> => {
    const ledger = await deps.runtimeInstalls.read();
    const offered = ledger.offered ?? [];
    if (offered.length === 0) {
        return [];
    }
    const settled = new Set((ledger.settled ?? []).map((entry) => `${entry.tool}\u0000${entry.hash}`));
    const declinedInstalls = new Set(ledger.installs.filter((entry) => entry.declinedAt !== undefined).map((entry) => entry.tool));
    const approved = new Set(
        splitBlocks(((await deps.files.read(customPathOf(deps.workspace.root))) ?? "").trim()).map((block) => `${block.name}\u0000${sha256Hex(block.body.trim())}`),
    );
    const done: { tool: string; hash: string }[] = [];
    const discarded: EnvironmentOffer[] = [];
    for (const offer of offered) {
        const body = (await deps.files.read(join(draftsDirOf(deps.workspace.root), `${offer.tool}.Dockerfile`)))?.trim();
        if (body !== undefined && body !== "") {
            if (sha256Hex(body) !== offer.hash) {
                done.push(offer);
            }
            continue;
        }
        const key = `${offer.tool}\u0000${offer.hash}`;
        if (settled.has(key) || approved.has(key) || (offer.install !== undefined && declinedInstalls.has(offer.install))) {
            done.push(offer);
            continue;
        }
        discarded.push(offer);
    }
    const installs = discarded.flatMap((offer) => (offer.install === undefined ? [] : [offer.install]));
    if (installs.length > 0) {
        await deps.runtimeInstalls.decline(installs, at);
    }
    const revisions = discarded.filter((offer) => offer.install === undefined);
    if (revisions.length > 0) {
        await deps.runtimeInstalls.settle(revisions, at);
    }
    for (const offer of discarded) {
        await dropFromProposal(deps, offer.tool);
    }
    await deps.runtimeInstalls.withdrawOffers([...done, ...discarded]);
    return discarded.map((offer) => offer.tool);
};
