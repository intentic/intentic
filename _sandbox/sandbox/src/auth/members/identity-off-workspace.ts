import { join } from "node:path";
import { stateRelPath } from "../../state-paths.js";
import { defineStep } from "../../store/evolution/state-steps.js";
import { membersDocument, ownerDocument } from "../auth.js";
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
