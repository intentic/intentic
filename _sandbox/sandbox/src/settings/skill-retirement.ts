import { errorMessage } from "@intentic/base/errors";
import type { Services } from "../composition.js";
import { parseSkillFile, SKILL_FILE, skillFolderNames } from "../skill-file.js";
import { type DaemonSkillWriter, loadedSkillsRoot, skillWriterOf, trashLoadedSkill } from "../store/loaded-skills.js";
import { join } from "node:path";
import { bakedSkillNames } from "./skills.js";

// SKILLS A RELEASE RETIRED LEAVE THE AGENT'S VIEW (2026-10-12). Every daemon writer stamps what it writes into
// `.agents/skills/` (store/loaded-skills.ts), and this boot pass removes a stamped skill no current writer claims.
// Before it, nothing did: the `drafts` skill outlived the drafts queue's rename to approvals by weeks, its description
// triggering on the same requests as the approvals skill and sending agents to a folder the daemon no longer watches.
// Removal sets the folder aside in /history/trash (convergence rule 5), and a skill the pass cannot read, or whose
// writer it does not know, is left standing and reported (rule 6).

// Which names a writer keeps. `names`: exactly these, so a stamped skill of that writer under any other name is a
// leftover. `self`: the writer converges its own set (a capability's skill goes with its last entry, the account
// skills sweep their own stamp), so this pass never judges its names.
type SkillClaim = { readonly kind: "names"; readonly names: () => readonly string[] } | { readonly kind: "self"; readonly by: string };

// Keyed by the writer union, so a writer added in loaded-skills.ts fails the typecheck until it says what it keeps.
const CLAIMS = {
    approvals: { kind: "names", names: () => ["approvals"] },
    "baked-tool": { kind: "names", names: bakedSkillNames },
    ssh: { kind: "names", names: () => ["ssh"] },
    account: { kind: "self", by: "convergeAccountSkills (capabilities/account-skills.ts)" },
    cli: { kind: "self", by: "the cli handler's remove" },
    peer: { kind: "self", by: "the peer handler's remove and rename" },
    tunnel: { kind: "self", by: "the tunnel handler's remove" },
} satisfies Record<DaemonSkillWriter, SkillClaim>;

const isDaemonWriter = (writer: string): writer is DaemonSkillWriter => Object.hasOwn(CLAIMS, writer);

// Writer ids a release took out of DAEMON_SKILL_WRITERS (store/loaded-skills.ts): every skill still stamped with one is a leftover. A stamp
// naming a writer in neither list (a newer release's, seen after a rollback) is doubt, and stays.
const RETIRED_SKILL_WRITERS: ReadonlySet<string> = new Set<string>();

// Skills written before writers stamped them, each recognised by its shipped text rather than its name alone, so an
// owner's own skill that happens to share the name is never taken.
interface RetiredSkill {
    readonly name: string;
    readonly why: string;
    readonly matches: (text: string) => boolean;
}

export const RETIRED_SKILLS: readonly RetiredSkill[] = [
    {
        name: "drafts",
        why: "the drafts queue became approvals on 2026-09-02 (approvals/approvals-store.ts); its skill is the approvals skill",
        matches: (text) => {
            const parsed = parseSkillFile(text);
            return parsed.name === "drafts" && (parsed.description?.startsWith("Create post drafts for owner approval") ?? false);
        },
    },
];

// Why the daemon would take this loaded skill away, or undefined to keep it; pure over the folder name and its text.
export const retiredSkillReason = (name: string, text: string): string | undefined => {
    const writer = skillWriterOf(text);
    if (writer === undefined) {
        const retired = RETIRED_SKILLS.find((skill) => skill.name === name);
        return retired !== undefined && retired.matches(text) ? retired.why : undefined;
    }
    if (RETIRED_SKILL_WRITERS.has(writer)) {
        return `its writer "${writer}" was retired`;
    }
    if (!isDaemonWriter(writer)) {
        return undefined;
    }
    const claim: SkillClaim = CLAIMS[writer];
    if (claim.kind !== "names" || claim.names().includes(name)) {
        return undefined;
    }
    return `no current "${writer}" skill is named ${name}`;
};

export interface SkillRetirementPass {
    // Names moved to the trash this pass, with where each went.
    readonly trashed: readonly { readonly name: string; readonly to: string; readonly why: string }[];
    readonly kept: number;
    // Folders this pass could not judge or move, left as they were; the next boot tries again.
    readonly skipped: readonly { readonly name: string; readonly why: string }[];
}

// One pass over the loaded folder. A folder whose SKILL.md does not read is skipped and reported, never removed; an
// unlistable folder fails the pass whole rather than reading as empty.
export const retireSkills = async (
    services: Pick<Services, "files" | "workspace">,
    historyRoot: string,
    now: () => number = Date.now,
): Promise<SkillRetirementPass> => {
    const root = services.workspace.root;
    const trashed: { name: string; to: string; why: string }[] = [];
    const skipped: { name: string; why: string }[] = [];
    let kept = 0;
    for (const name of await skillFolderNames(loadedSkillsRoot(root), "throw")) {
        const text = await services.files.read(join(loadedSkillsRoot(root), name, SKILL_FILE));
        if (text === undefined) {
            skipped.push({ name, why: `${SKILL_FILE} missing or unreadable` });
            continue;
        }
        const why = retiredSkillReason(name, text);
        if (why === undefined) {
            kept += 1;
            continue;
        }
        try {
            const to = await trashLoadedSkill(root, historyRoot, name, now());
            if (to !== undefined) {
                trashed.push({ name, to, why });
            }
        } catch (error) {
            skipped.push({ name, why: `could not be moved to the trash: ${errorMessage(error)}` });
        }
    }
    return { trashed, kept, skipped };
};
