import { access } from "node:fs/promises";
import { onPath } from "../image/on-path.js";

// What an agent's shell is told so plain `rg` searches documents: RIPGREP_CONFIG_PATH names the config the image bakes
// (`fileq ripgrep-config`, Dockerfile), which routes pdf, docx, xlsx, pptx, odt, ods, odp, rtf and epub through fileq's
// preprocessor; code and every other file read exactly as before. Only while the `documentSearch` setting is on, since
// it is the keeper (shadow-keeper.ts) that keeps the preprocessor on its fast path.
// Claude Code's Grep tool runs its own embedded ripgrep with `--no-config` (checked in 0.3.296), so it would skip
// documents whatever this says; USE_BUILTIN_RIPGREP=0 hands it the image's `rg` instead, which reads the config.

export const DOCUMENT_RIPGREP_CONFIG = "/etc/fileq/ripgreprc";

const exists = (path: string): Promise<boolean> => access(path).then(
    () => true,
    () => false,
);

/** The variables, or none: setting off, no baked config (a dev checkout), or an owner who set their own config. */
export const documentSearchEnv = async (enabled: boolean, configPath: string = DOCUMENT_RIPGREP_CONFIG): Promise<Record<string, string>> => {
    const owners = process.env["RIPGREP_CONFIG_PATH"];
    if (!enabled || (owners !== undefined && owners !== "") || !(await exists(configPath))) {
        return {};
    }
    const config = { RIPGREP_CONFIG_PATH: configPath };
    return (await onPath("rg")) ? { ...config, USE_BUILTIN_RIPGREP: "0" } : config;
};
