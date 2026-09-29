import { OPTIONS } from "./features.js";

// `.claude-plugin/plugin.json`, as data. The file is committed so the manifest reads in review like any other source, and
// manifest.test.ts holds it equal to this; the build stamps the release version into it the way set-versions.sh stamps
// every package.json, transiently, in CI.

export const PLUGIN_NAME = "intentic";

export interface PluginManifest {
    readonly name: string;
    readonly displayName: string;
    readonly version: string;
    readonly description: string;
    readonly author: { readonly name: string };
    readonly homepage: string;
    readonly repository: string;
    readonly license: string;
    readonly keywords: readonly string[];
    readonly skills: string;
    readonly outputStyles: string;
    readonly userConfig: typeof OPTIONS;
}

export const manifest = (version: string): PluginManifest => ({
    name: PLUGIN_NAME,
    displayName: "Intentic",
    version,
    description:
        "Cheaper, sharper Claude Code sessions: Bash output trimmed before Claude reads it, a project map and this project's field notes at session start, iq code search and fileq document reading taught, document shadows kept fresh, and /intentic:stats to show what each one saved. Every mechanism is a switch in /config.",
    author: { name: "intentic" },
    homepage: "https://github.com/intentic/intentic/tree/main/_sandbox/claude-plugin",
    repository: "https://github.com/intentic/intentic",
    license: "MIT",
    keywords: ["context", "token-savings", "output-filter", "code-search", "documents", "measurement"],
    // Built from the texts other packages own (fileq's skill, iq's skill, the field-notes brief), so the build writes them
    // and git ignores them; the plugin's own `skills/` holds only what is written here.
    skills: "./generated/skills",
    outputStyles: "./generated/output-styles",
    userConfig: OPTIONS,
});
