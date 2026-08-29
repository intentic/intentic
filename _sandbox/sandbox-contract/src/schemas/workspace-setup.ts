// workspace setup (dependency readiness)
import { z } from "zod";
// One project under /work and whether its dependencies are actually installed. A drop omits node_modules/.venv
// on purpose, so a freshly imported project is present-but-unusable until this says "ready", the import UI,
// the agent's post-edit type-check, and the agent's turn context all gate on it.
// `dir` is root-relative ("" = the workspace root itself); `manager` is the real binary (pnpm/npm/uv/…);
// `evidence` is the file that decided it ("pnpm-lock.yaml"), so the UI can show WHY, not just what.
// state: ready | installing | needs-setup | unsupported (manager absent from this sandbox, `manager` names it)
//      | stale, installed ONCE and since outgrown: the manifests declare dependencies that are not on disk,
//        which is what an agent leaves behind when it adds one and does not install it. Same command fixes it,
//        so `missing` (how many names cannot resolve) is what separates the two in the UI's wording.
export const ProjectSetupSchema = z.object({
    dir: z.string().describe("Where the project is, relative to the workspace root. Empty means the root itself."),
    ecosystem: z.enum(["node", "python"]).describe("Which language's tooling it uses."),
    manager: z.string().describe("The tool that would do the installing."),
    command: z.string().describe("The exact command that would run."),
    evidence: z.string().describe("The file that decided all of the above, so the answer can be checked rather than trusted."),
    state: z
        .enum(["ready", "installing", "needs-setup", "unsupported", "stale"])
        .describe(
            "Ready means its dependencies are really there. Stale means it was installed once and has since outgrown that, which is what an agent leaves behind when it adds a dependency without installing it. Unsupported means this sandbox has no such tool.",
        ),
    missing: z.number().optional().describe("How many declared dependencies cannot be found on disk. What separates never-installed from outgrown."),
});
export type ProjectSetup = z.infer<typeof ProjectSetupSchema>;
export const WorkspaceSetupSchema = z.object({
    projects: z.array(ProjectSetupSchema).describe("Every project the sandbox found, and whether each is usable."),
});
export type WorkspaceSetup = z.infer<typeof WorkspaceSetupSchema>;
// Install these projects' dependencies. Dirs already ready, already installing, or whose manager is missing are
// skipped server-side, so a stale client list can't spawn redundant installs, `started` is what actually ran.
export const WorkspaceInstallSchema = z.object({
    dirs: z
        .array(z.string().max(500))
        .min(1)
        .max(50)
        .describe(
            "Which projects to install, by folder. Ones already ready, already installing, or with no tool to install them are skipped rather than refused.",
        ),
});
export const WorkspaceInstallResultSchema = z.object({
    queued: z.array(z.string()).describe("Which of them actually started, which is not necessarily what you asked for."),
});
