import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import type { Services } from "../composition.js";
import { jsonFile } from "../store/json-file.js";
import { appPanelKey, buildAppSpec } from "../workspace/layout/app-previews.js";
import { statePath } from "../workspace/layout/state-paths.js";

// What this workspace runs on boot: one entry per `<repo>/_apps/<app>` with its dev command, so every boot restarts it,
// not only the seed's first one. `autostart` (main.ts) starts what the file names and is idempotent; a missing folder
// is skipped, not deleted.

const AutostartAppSchema = z.object({
    // The repo directory under /work and the instance under its `_apps/`, the pair `appPanelKey` names.
    repo: z.string().min(1),
    app: z.string().min(1),
    // The dev command template; `{pkg}` stands for the app package's real name.
    dev: z.string().min(1),
});
const AutostartSchema = z.object({ apps: z.array(AutostartAppSchema) });

export type AutostartApp = z.infer<typeof AutostartAppSchema>;
type Autostart = z.infer<typeof AutostartSchema>;

const store = (root: string) =>
    jsonFile<Autostart>(statePath(root, ".intentic/config/autostart.json"), {
        parse: (raw) => AutostartSchema.safeParse(raw).data,
        fallback: () => ({ apps: [] }),
    });

export const readAutostart = async (root: string): Promise<readonly AutostartApp[]> => (await store(root).read()).apps;

// Add an app to the list, once: the same repo/app pair recorded twice is one app to start.
export const recordAutostart = async (root: string, entry: AutostartApp): Promise<void> => {
    await store(root).update((current) =>
        current.apps.some((app) => app.repo === entry.repo && app.app === entry.app) ? current : { apps: [...current.apps, entry] },
    );
};

// Returns the `pnpm --filter` target: the app package's real name read from disk, not assumed from a template's scope.
const packageName = (appDir: string): string | undefined => {
    try {
        return (JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { name?: string }).name;
    } catch {
        return undefined;
    }
};

export interface AutostartOutcome {
    readonly started: readonly string[];
    readonly skipped: readonly { readonly key: string; readonly why: string }[];
}

// The three dependencies a boot step needs: workspace root, preview URL/zone config, and the process manager. Picked
// individually so a test only needs to stand up three members, not all of `Services`.
export type AutostartDeps = Pick<Services, "config" | "processes" | "workspace">;

// Starts everything the file names, using the same spec builder, zone and sandbox id as the Start button, so the result
// matches a manual start. Per-entry failures are reported, not thrown, so one bad app does not block the rest.
export const runAutostart = async (services: AutostartDeps): Promise<AutostartOutcome> => {
    const root = services.workspace.root;
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    const started: string[] = [];
    const skipped: { key: string; why: string }[] = [];
    for (const entry of await readAutostart(root)) {
        const key = appPanelKey(entry.repo, entry.app);
        const repoDir = join(root, entry.repo);
        const appDir = join(repoDir, "_apps", entry.app);
        if (!existsSync(appDir)) {
            skipped.push({ key, why: "its folder is gone" });
            continue;
        }
        const pkg = packageName(appDir);
        if (pkg === undefined) {
            skipped.push({ key, why: "no named package.json" });
            continue;
        }
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of apps, started in the order recorded
            await services.processes.start(
                key,
                buildAppSpec({ repo: entry.repo, repoDir, pkg, app: entry.app, preview: { dev: entry.dev }, zone, sandboxId }),
            );
            started.push(key);
        } catch (error) {
            skipped.push({ key, why: error instanceof Error ? error.message : "could not start" });
        }
    }
    return { started, skipped };
};
