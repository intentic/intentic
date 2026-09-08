import { z } from "zod";

// A registry entry's `source` is a pointer to somebody else's repository at a commit, in the shapes Claude Code's
// plugin-marketplace format defines. `resolveSource` maps the clonable shapes onto url/ref/path, returning undefined
// (not dropping the entry) for the ones it can't clone (npm, say).

// The resolved pointer: exactly the fields a plugin- or extension-capability install needs.
export const RegistryInstallSchema = z.object({
    url: z.string(),
    ref: z.string().optional(),
    path: z.string().optional(),
});
export type RegistryInstall = z.infer<typeof RegistryInstallSchema>;

// A relative path means the code lives in the registry repo itself (metadata.pluginRoot prepends); every other
// shape points outward. Kept as `unknown` going in: an unrecognized shape degrades to "not installable" rather than
// failing the whole file to parse.
export const resolveSource = (source: unknown, registryUrl: string, pluginRoot: string | undefined): RegistryInstall | undefined => {
    if (typeof source === "string") {
        const relative = source.replace(/^\.\//, "");
        const root = pluginRoot?.replace(/^\.\//, "").replace(/\/$/, "");
        return { url: registryUrl, path: root !== undefined && root !== "" ? `${root}/${relative}` : relative };
    }
    if (typeof source !== "object" || source === null) {
        return undefined;
    }
    const s = source as { source?: string; repo?: string; url?: string; path?: string; ref?: string; sha?: string };
    // An exact sha pins harder than a ref when both are present.
    const ref = s.sha ?? s.ref;
    if (s.source === "github" && typeof s.repo === "string") {
        return { url: `https://github.com/${s.repo}.git`, ...(ref !== undefined ? { ref } : {}) };
    }
    if (s.source === "url" && typeof s.url === "string") {
        return { url: s.url, ...(ref !== undefined ? { ref } : {}) };
    }
    if (s.source === "git-subdir" && typeof s.url === "string" && typeof s.path === "string") {
        return { url: s.url, path: s.path, ...(ref !== undefined ? { ref } : {}) };
    }
    return undefined;
};

// A full lowercase commit sha, the only ref an install may be pinned to: a tag or branch can move under it.
export const FULL_SHA = /^[0-9a-f]{40}$/;

// Whether this pointer names one immutable commit. An extension install requires it, since extension code runs
// trusted in the owner's browser and a branch name can move under a force-push; plugins are laxer, they load into the
// agent, not the browser.
export const isShaPinned = (install: RegistryInstall | undefined): boolean => install?.ref !== undefined && FULL_SHA.test(install.ref);

// `owner/repo` for a GitHub pointer, what the scanner keys facts by and the gallery links to; undefined off GitHub.
export const githubRepoOf = (install: RegistryInstall | undefined): string | undefined => {
    if (install === undefined) {
        return undefined;
    }
    const match = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(install.url);
    return match === null ? undefined : `${match[1]}/${match[2]}`;
};
