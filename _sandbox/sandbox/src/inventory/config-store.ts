import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, scaffoldDeployConfig } from "@intentic/scaffold";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import { AGENT_GIT_AUTHOR } from "../git/git.js";

// Read/write + commit the intent repo's deploy.config.ts. The daemon owns this file (the browser edits it only
// through daemon routes, never directly); a repo with no config yet reads as a fresh neutral scaffold. Shared by
// the inventory routes and the app-scaffold route so the file + commit logic lives in one place.
export interface ConfigStore {
    readonly read: () => Promise<string>;
    readonly write: (content: string, message: string) => Promise<void>;
}

// What this reaches for out of the daemon: files, git, workspace. Stated rather than taking Services whole,
// so a test stands up three seams instead of a hundred and thirty.
export type ConfigStoreDeps = Pick<Services, "files" | "git" | "workspace">;

export const createConfigStore = (services: ConfigStoreDeps): ConfigStore => {
    const configPath = join(services.workspace.repos.intent, CONFIG_FILE);
    return {
        read: async () => (await services.files.read(configPath)) ?? scaffoldDeployConfig([]),
        write: async (content, message) => {
            // deploy.config.ts lives in the intent repo, which exists only once DevOps is active. Refuse to write
            // (which would silently re-create the repo) on an empty sandbox.
            if (!existsSync(services.workspace.repos.intent)) {
                throw new ORPCError("PRECONDITION_FAILED", { message: "DevOps is not active, activate it before editing infrastructure." });
            }
            await services.files.write(configPath, content);
            await services.git.commitAll(services.workspace.repos.intent, message, AGENT_GIT_AUTHOR);
        },
    };
};
