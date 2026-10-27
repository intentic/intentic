import { errorMessage } from "@intentic/base/errors";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    canonicalEgressPolicy,
    egressOnlyTightens,
    type EgressOwnerKeys,
    type EgressPolicy,
    type EgressProof,
    type EgressStatus,
    EgressStatusSchema,icEgressSetArgs,icEgressShowArgs
} from "@intentic/sandbox-contract/schemas/egress";
import { environmentKeyOf } from "@intentic/sandbox-contract/schemas/hosts";
import { parseJsonWith } from "@intentic/base/json";
import { machineId } from "../../machine-id.js";
import { wslEnvironment } from "../../environments/wsl.js";
import { audit } from "../audit.js";
import { assertScope } from "../policy.js";
import { findIn, fleet, icFlow, runIc } from "../tools/sandboxes.js";
import { type EgressPin, type EgressPinStore, egressPinStore, narrowsOwnerKeys, type PinnedSandbox, sameOwnerKeys } from "./pins.js";
import { EgressRefusal, looseningText, verifyEgressProof } from "./proof.js";

/* THE `set-egress` OP (2026-10-27): a sandbox's whole egress policy, carried out through `ic sandbox egress`. A change
   that only tightens (egress.ts's egressOnlyTightens, against what ic holds now) is carried out as it comes, from any
   door. Any other change arrives through the sandbox's own daemon, which is inside the fence, so it is carried out only
   under the owner's passkey over exactly it, checked here against the keys this machine pinned (pins.ts, proof.ts). */

export interface SetEgressAsk {
    readonly slug: string;
    readonly policy: EgressPolicy;
    readonly proof: EgressProof | undefined;
    readonly ownerKeys: EgressOwnerKeys | undefined;
    // The link the order came over (its sandbox URL), recorded with a pin it makes.
    readonly via: string;
}

// Everything the decision touches outside itself, so the whole of it is asserted without an ic or a disk.
export interface SetEgressSeams {
    // Which sandbox the slug is now (its id from the listing), or a throw naming the ones there are.
    readonly sandbox: (slug: string) => Promise<PinnedSandbox>;
    readonly status: (slug: string) => Promise<EgressStatus>;
    readonly apply: (slug: string, policy: EgressPolicy, onLine: (line: string) => void) => Promise<void>;
    readonly identity: () => Promise<{ readonly machineId: string; readonly environment: string }>;
    readonly pins: EgressPinStore;
    readonly audit: (entry: { tool: string; ok: boolean; detail: string }) => void;
    readonly now: () => number;
}

// What `ic sandbox egress <slug> --json` printed: its last JSON line, read as the contract's status. Pure.
export const egressStatusFrom = (stdout: string): EgressStatus | undefined => {
    const line = stdout
        .split(/\r?\n/)
        .map((text) => text.trim())
        .findLast((text) => text.startsWith("{"));
    return line === undefined ? undefined : parseJsonWith(line, EgressStatusSchema);
};

const noPinSentence = (slug: string, opens: string): string =>
    `${opens[0]?.toUpperCase() ?? ""}${opens.slice(1)}, and this machine has no passkey pinned for "${slug}", so it cannot check that you asked for it. Change it on the machine itself with \`ic sandbox egress ${slug}\`, or add a passkey in Access → Sign-in, save the fence once from the editor (a change that only tightens pins your passkeys here), then make this change again.`;

// A tightening carried out; the first one carrying the owner's passkeys pins them (trust on first use).
const tighten = async (ask: SetEgressAsk, sandbox: PinnedSandbox, seams: SetEgressSeams, onLine: (line: string) => void): Promise<string> => {
    await seams.apply(ask.slug, ask.policy, onLine);
    const said = `Set the egress policy of "${ask.slug}" (${ask.policy.profile}, ${ask.policy.allow.length} exception${ask.policy.allow.length === 1 ? "" : "s"}).`;
    seams.audit({ tool: "set-egress", ok: true, detail: `${ask.slug}: tightened to ${JSON.stringify(canonicalEgressPolicy(ask.policy))}, via ${ask.via}` });
    if (ask.ownerKeys === undefined || ask.ownerKeys.keys.length === 0) {
        return said;
    }
    let held: EgressPin | undefined;
    try {
        held = await seams.pins.read(sandbox);
    } catch (error) {
        // An unreadable store is never written over: the pins in it would be lost to a first use.
        seams.audit({ tool: "set-egress", ok: false, detail: `${ask.slug}: passkeys not pinned, the pin store is unreadable: ${errorMessage(error)}` });
        return said;
    }
    if (held !== undefined) {
        return said;
    }
    await seams.pins.write({ slug: sandbox.slug, sandboxId: sandbox.sandboxId, owner: ask.ownerKeys, counters: {}, pinnedAt: seams.now(), pinnedBy: ask.via });
    seams.audit({
        tool: "set-egress",
        ok: true,
        detail: `${ask.slug}: pinned ${ask.ownerKeys.keys.length} passkey(s) for ${ask.ownerKeys.rpId} on first use, handed over by ${ask.via}: ${ask.ownerKeys.keys.map((key) => key.name ?? key.id).join(", ")}`,
    });
    return `${said} This machine now trusts your ${ask.ownerKeys.keys.length === 1 ? "passkey" : "passkeys"} for loosening it.`;
};

// A loosening, carried out only under a proof from a pinned key.
const loosen = async (
    ask: SetEgressAsk,
    sandbox: PinnedSandbox,
    current: EgressStatus,
    seams: SetEgressSeams,
    onLine: (line: string) => void,
): Promise<string> => {
    const opens = looseningText(ask.slug, current.policy, ask.policy);
    const pin = await seams.pins.read(sandbox);
    if (pin === undefined || pin.owner.keys.length === 0) {
        throw new EgressRefusal(noPinSentence(ask.slug, opens));
    }
    if (ask.proof === undefined) {
        throw new EgressRefusal(`${opens[0]?.toUpperCase() ?? ""}${opens.slice(1)}: sign it with your passkey.`);
    }
    const { machineId: id, environment } = await seams.identity();
    const verified = verifyEgressProof({
        proof: ask.proof,
        slug: ask.slug,
        asked: ask.policy,
        revision: current.revision,
        machineId: id,
        environment,
        ownerKeys: ask.ownerKeys,
        pin,
        now: seams.now(),
    });
    // The counter is kept before ic runs: an assertion is spent once it is checked, whatever ic then says.
    // The pin follows the owner's passkeys only where they shrank: a key the owner added is trusted here only after a
    // reset on this machine (pins.ts narrowsOwnerKeys), however the signature reads.
    const differs = ask.ownerKeys !== undefined && !sameOwnerKeys(ask.ownerKeys, pin.owner);
    const moves = verified.ownerKeysSigned && differs && ask.ownerKeys !== undefined && narrowsOwnerKeys(ask.ownerKeys, pin.owner);
    const grew = differs && !moves;
    const owner = moves && ask.ownerKeys !== undefined ? ask.ownerKeys : pin.owner;
    const counters: Record<string, number> = Object.fromEntries(Object.entries(pin.counters).filter(([key]) => owner.keys.some((pinned) => pinned.id === key)));
    if (owner.keys.some((pinned) => pinned.id === verified.keyId)) {
        counters[verified.keyId] = verified.counter;
    }
    const next: EgressPin = { ...pin, owner, counters };
    if (moves) {
        next.replacedAt = seams.now();
    }
    await seams.pins.write(next);
    await seams.apply(ask.slug, ask.policy, onLine);
    seams.audit({
        tool: "set-egress",
        ok: true,
        detail: `${ask.slug}: loosened from revision ${current.revision} to ${JSON.stringify(canonicalEgressPolicy(ask.policy))}, signed by passkey ${verified.keyId}, via ${ask.via}${moves ? `; pin moved to ${owner.keys.length} passkey(s): ${owner.keys.map((key) => key.name ?? key.id).join(", ")}` : ""}`,
    });
    const pinSaid = moves
        ? " This machine no longer trusts the passkeys you removed."
        : grew
          ? ` Passkeys you added since this machine pinned yours are not trusted for "${ask.slug}" here until you run \`intentic-machine egress trust ${ask.slug} --reset\` on this machine and save the fence once from the editor.`
          : "";
    return `Set the egress policy of "${ask.slug}" under your passkey: ${opens.replace(/^this change /u, "it ")}.${pinSaid}`;
};

// The decision, over its seams. A refusal is audited and thrown as the sentence the card shows.
export const setEgressWith = async (ask: SetEgressAsk, seams: SetEgressSeams, onLine: (line: string) => void): Promise<string> => {
    try {
        const sandbox = await seams.sandbox(ask.slug);
        const current = await seams.status(ask.slug);
        return egressOnlyTightens(current.policy, ask.policy)
            ? await tighten(ask, sandbox, seams, onLine)
            : await loosen(ask, sandbox, current, seams, onLine);
    } catch (error) {
        seams.audit({ tool: "set-egress", ok: false, detail: `${ask.slug}: ${error instanceof EgressRefusal ? "refused" : "failed"}: ${errorMessage(error)}, via ${ask.via}` });
        throw error;
    }
};

// ---- the real seams ----

const status = async (slug: string): Promise<EgressStatus> => {
    const run = await runIc(icEgressShowArgs(slug), () => {});
    const read = run.code === 0 ? egressStatusFrom(run.output) : undefined;
    if (read === undefined) {
        throw new Error(
            `This machine's ic did not say what egress policy "${slug}" has, so the change was not made. Update the agent on this machine (intentic-machine upgrade), then try again.\n\n${run.output}`,
        );
    }
    return read;
};

const apply = async (slug: string, policy: EgressPolicy, onLine: (line: string) => void): Promise<void> => {
    const run = await icFlow(slug, icEgressSetArgs(slug, policy), onLine, { moves: false });
    if (run.code !== 0) {
        throw new Error(`ic did not set the egress policy of "${slug}" on this machine.\n\n${run.output}`);
    }
};

const realSetEgressSeams = (pins: EgressPinStore = egressPinStore()): SetEgressSeams => ({
    sandbox: async (slug) => {
        const row = findIn(await fleet(), slug);
        return { slug: row.slug, sandboxId: row.sandboxId ?? null };
    },
    status,
    apply,
    // The same environment key this agent enrolls with (device/commands.ts), so a document names the side it was signed for.
    identity: async () => ({ machineId: machineId(), environment: environmentKeyOf({ wsl: await wslEnvironment() }) }),
    pins,
    audit: (entry) => void audit(entry),
    now: Date.now,
});

// The op as the router calls it: behind "Manage sandboxes", like every verb that changes one.
export const setEgress = async (ask: SetEgressAsk, scopes: DeviceScopes, onLine: (line: string) => void): Promise<string> => {
    assertScope(scopes, "sandboxes");
    return await setEgressWith(ask, realSetEgressSeams(), onLine);
};
