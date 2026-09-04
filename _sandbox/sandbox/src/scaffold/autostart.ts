import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import type { Services } from "../composition.js";
import { jsonFile } from "../store/json-file.js";
import { appPanelKey, buildAppSpec } from "../workspace/app-previews.js";
import { statePath } from "../workspace/state-paths.js";

/* WHAT THIS WORKSPACE RUNS WHEN IT BOOTS, as a file the workspace carries rather than a fact the seed knew once.
 *
 * The starter site used to be started from inside the seed that copied it in, and only there. That made the
 * dev server a property of ONE boot: the first one, of a workspace that arrived empty. Every other boot of the
 * same box — a hosted machine woken after its idle stop, a pool volume the platform prepared ahead of demand,
 * a plain daemon restart — found the site on disk with nothing to say it should be running, and opened on
 * "isn't running" with a Start button. The product's first screen depended on which boot you happened to get.
 *
 * So the seed RECORDS what should run, here, and a boot step (main.ts `autostart`) starts whatever the file
 * names, every time. The file is workspace configuration in the ordinary sense: tracked by the root repo,
 * carried by an export, one entry per app instance (`<repo>/_apps/<app>`) with the dev command the app is
 * started with, the same `{pkg}` template `buildAppSpec` fills for the Start button. Starting is idempotent
 * (the process manager no-ops a key it already tracks), so the step is safe to run after a seed that started
 * nothing and after one that did.
 *
 * An entry whose folder is gone is skipped, not deleted: the user removing a repo is the user's business, and
 * an entry that outlives its app costs one log line per boot and nothing else. */

const AutostartAppSchema = z.object({
    // The repo directory under /work and the instance under its `_apps/`, the pair `appPanelKey` names.
    repo: z.string().min(1),
    app: z.string().min(1),
    // The dev command template, `{pkg}` standing for the app package's real name (workspace/app-previews.ts).
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

// The `pnpm --filter` target is the app package's REAL name, read off disk, never assumed from a template's scope.
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

/* Start everything the file names. Same spec builder, same zone and sandbox id as the Start button and the
 * apps routes, so a server this step starts is byte-for-byte the one a click would have started. Per-entry
 * failures are reported, never thrown: one app that cannot start must not keep the rest down. */
export const runAutostart = async (services: Services): Promise<AutostartOutcome> => {
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
