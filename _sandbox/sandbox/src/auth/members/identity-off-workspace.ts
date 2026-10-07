import { join } from "node:path";
import { stateRelPath } from "../../state-paths.js";
import { defineStep } from "../../store/evolution/state-steps.js";
import { membersDocument, ownerDocument } from "../auth.js";
import { passkeysDocument } from "../passkeys/passkey-store.js";
import { controlTokensDocument } from "../tokens/control-tokens.js";

// The owner file, the access roster and the control tokens, brought from the workspace to the history volume. Every
// release before 2026-10-06 kept them in `.intentic/identity/`, which every turn writes as freely as its person does:
// a member's agent could grant its person the maintainer tier, and a token file it wrote admitted a program of its own.
// Each file is copied, so a rollback to a build that reads the workspace still finds it; nothing reads that copy here.
// One-shot: the move ends with a roster on the history volume (an empty one when the workspace held none), and a
// roster there is what says it already ran, so a file a turn plants at the old address later is never brought over.

// Each with where a release before the move kept it, as the workspace table still declares it.
const MOVED = [
    { spec: ownerDocument, legacy: stateRelPath(".intentic/identity/owner.json") },
    { spec: membersDocument, legacy: stateRelPath(".intentic/identity/members.json") },
    { spec: controlTokensDocument, legacy: stateRelPath(".intentic/identity/control-tokens.json") },
] as const;

export const identityOffWorkspaceStep = defineStep({
    id: "identity-off-workspace",
    describe: "moves the owner, the access roster and the control tokens from the workspace to the history volume",
    plan: async (context) => {
        const roster = join(context.roots.history, membersDocument.path);
        if ((await context.kind(roster)) !== undefined) {
            return undefined;
        }
        const writes = new Map<string, string | undefined>();
        const changes: string[] = [];
        for (const { spec, legacy } of MOVED) {
            const target = join(context.roots.history, spec.path);
            const text = await context.read(join(context.roots.workspace, legacy));
            if (text === undefined || (await context.kind(target)) !== undefined) {
                continue;
            }
            writes.set(target, text);
            changes.push(`copies ${legacy} to ${spec.path} on the history volume`);
        }
        if (!writes.has(roster)) {
            writes.set(roster, `${JSON.stringify({ members: [] }, undefined, 2)}\n`);
            changes.push(`starts ${membersDocument.path} on the history volume with nobody on it`);
        }
        return { changes, writes };
    },
});

// The passkeys, the owner's require-a-passkey switch and the hashes of their recovery codes, brought over the same way.
// A passkey sign-in trusts the stored row's email and public key, so a row a turn wrote into the workspace file opened
// a session as whoever it named. A step of its own rather than one more file above, since that step has already run on
// every sandbox past 2026-10-06 and never runs again. The file on the history volume is what says this one ran (an
// empty one when the workspace held none), so a file planted at the old address later stays where it was put.
const LEGACY_PASSKEYS = stateRelPath(".intentic/identity/passkeys.json");

export const passkeysOffWorkspaceStep = defineStep({
    id: "passkeys-off-workspace",
    describe: "moves the passkeys, the require-a-passkey switch and the recovery code hashes from the workspace to the history volume",
    plan: async (context) => {
        const target = join(context.roots.history, passkeysDocument.path);
        if ((await context.kind(target)) !== undefined) {
            return undefined;
        }
        const text = await context.read(join(context.roots.workspace, LEGACY_PASSKEYS));
        if (text !== undefined) {
            return { changes: [`copies ${LEGACY_PASSKEYS} to ${passkeysDocument.path} on the history volume`], writes: new Map([[target, text]]) };
        }
        const empty = `${JSON.stringify({ required: false, credentials: [], recovery: [] }, undefined, 2)}\n`;
        return { changes: [`starts ${passkeysDocument.path} on the history volume with no passkey in it`], writes: new Map([[target, empty]]) };
    },
});
