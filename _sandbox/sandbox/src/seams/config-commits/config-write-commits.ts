import { sandboxRouteFor } from "@intentic/sandbox-contract";
import { VERSIONED_STATE_PATHS } from "@intentic/sandbox-contract/state/workspace-state";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Context, Next } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { versionSettingsWrite } from "./settings-versions.js";

// Which requests write a tracked workspace config file (.intentic/config/, VERSIONED_STATE_PATHS) as a page's or a card's
// own write, committed as it lands like the Agent tab's and a role's saves (settings-versions.ts). Named here, by the
// contract route a request resolves to, as the audit trail names its routes (audit/audit-http.ts), so a page's write is
// committed by being listed rather than by remembering a wrapper in its handler. Before this table only the pages that
// wrapped their write committed it; toggling an automation, an extension or a skill left the file dirty in the owner's
// checkout, where it read as their own edit and waited for a hand commit.
// The routes that already wrap their write (settings.set, roles.*, safety.setPolicy, capabilities.remove…) need no row;
// one listed anyway costs a status and commits nothing twice.
export const CONFIG_WRITES = new Map<string, string>([
    ["capabilities.add", "connection added"],
    ["capabilities.oauthToken", "connection signed in"],
    ["capabilities.dismiss", "suggestion dismissed"],
    ["skills.save", "skill"],
    ["skills.remove", "skill removed"],
    ["areas.save", "area"],
    ["areas.remove", "area removed"],
    ["loops.saveDesign", "loop design"],
    ["loops.removeDesign", "loop design removed"],
    ["workflows.save", "workflow"],
    ["workflows.remove", "workflow removed"],
    ["automations.upsert", "automation"],
    ["automations.setEnabled", "automation switched"],
    ["automations.remove", "automation removed"],
    ["automations.run", "automation run"],
    ["approvals.upsert", "approval"],
    ["approvals.remove", "approval removed"],
    ["extensions.create", "extension created"],
    ["extensions.remove", "extension removed"],
    ["extensions.setSettings", "extension settings"],
    ["extensions.setUpdatePolicy", "extension update policy"],
    ["extensions.setEnabled", "extension switched"],
    ["extensions.applyUpdate", "extension updated"],
    ["extensions.revert", "extension reverted"],
    ["extensions.checkUpdates", "extension updates"],
    // A card answered: an automation or an environment step approved or declined writes its manifest.
    ["needs.answer", "card answered"],
    // An agent's environment proposal arrives as a draft in environment.d/.
    ["needs.ask", "environment proposal"],
    ["POST /environment/approve", "environment approved"],
    ["POST /environment/reject", "environment rejected"],
    ["POST /environment/runtime-install", "environment runtime install"],
    ["POST /environment/remove", "environment step removed"],
    ["POST /engines/channel", "engine channel"],
]);

type CommitHost = Pick<Services, "agentWorktrees" | "git" | "logger">;

// The tracked config paths git reports as differing from HEAD in the main checkout (staged, unstaged, untracked, both
// sides of a rename), or undefined when git cannot say.
const changedAmong = async (dir: string, git: GitRunner): Promise<ReadonlySet<string> | undefined> => {
    try {
        const { stdout } = await git(dir, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...VERSIONED_STATE_PATHS]);
        const entries = stdout.split("\0");
        const changed = new Set<string>();
        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index] ?? "";
            if (entry === "") {
                continue;
            }
            changed.add(entry.slice(3));
            // A rename or copy is followed by its source, which changed too.
            if (entry.startsWith("R") || entry.startsWith("C")) {
                index += 1;
                changed.add(entries[index] ?? "");
            }
        }
        changed.delete("");
        return changed;
    } catch {
        // allow(silent-catch): a doubt is the answer, and the caller acts on it by committing nothing
        return undefined;
    }
};

// The middleware: below authentication, so a refused request costs no git call. A listed request notes which tracked
// config files already differ from HEAD, is served, and on success commits exactly the files that started differing
// while it ran. A file that differed before may hold the owner's own unsaved edits, so it stays theirs, uncommitted,
// as versionedRepoWrite leaves it. Awaited before the answer goes back, so the Changes view the page refreshes next is
// already clean.
export const commitConfigWrites =
    (services: CommitHost, routes: ReadonlyMap<string, string> = CONFIG_WRITES, git: GitRunner = defaultGit) =>
    async (c: Context<AppEnv>, next: Next): Promise<void> => {
        const route = sandboxRouteFor(c.req.method, c.req.path);
        const subject = route === undefined ? undefined : routes.get(route.name);
        if (subject === undefined) {
            await next();
            return;
        }
        const dir = services.agentWorktrees.mainDir("root");
        const before = await changedAmong(dir, git);
        await next();
        if (before === undefined || c.res.status >= 400) {
            return;
        }
        const after = await changedAmong(dir, git);
        const fresh = [...(after ?? [])].filter((path) => !before.has(path));
        if (fresh.length > 0) {
            await versionSettingsWrite(services, fresh, `Settings: ${subject}`, git);
        }
    };
