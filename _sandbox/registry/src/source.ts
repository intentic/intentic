import { z } from "zod";

/* WHERE A REGISTRY ENTRY'S CODE LIVES, and how that resolves to something cloneable.
 *
 * A registry never hosts code, an entry is a pointer to somebody else's repository at a commit. `source` is
 * that pointer in the shapes Claude Code's plugin-marketplace format already defines, so one registry repo
 * serves both consumers; `resolveSource` maps the shapes we can clone onto the url/ref/path a capability
 * install takes, and returns undefined for the ones we can't (npm, say) rather than dropping the entry,
 * an entry that exists but can't be installed in a click is information, a missing row is a bug report. */

// The resolved pointer: exactly the fields a plugin- or extension-capability install needs.
export const RegistryInstallSchema = z.object({
    url: z.string(),
    ref: z.string().optional(),
    path: z.string().optional(),
});
export type RegistryInstall = z.infer<typeof RegistryInstallSchema>;

/* A relative path means the code lives inside the registry repo itself, and metadata.pluginRoot prepends (the
 * Claude Code spec). Every other shape points outward at a repo of its own. Kept as `unknown` on the way in:
 * the format is somebody else's and gains shapes we don't know, and a source we can't read must degrade to
 * "not installable from here" rather than failing the whole file to parse. */
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

const FULL_SHA = /^[0-9a-f]{40}$/;

/* Whether this pointer names one immutable commit. An EXTENSION install requires it, extension code runs
 * trusted in the owner's browser, so the approved code and the running code have to be the same object, and a
 * branch name is a promise the upstream can break with a force-push. A registry entry that gives only a branch
 * is still listed and still readable; it just can't be a one-click install, which is the pressure that makes
 * authors pin. Plugins are laxer by design: they load into the agent, not the browser. */
export const isShaPinned = (install: RegistryInstall | undefined): boolean => install?.ref !== undefined && FULL_SHA.test(install.ref);

// `owner/repo` for a GitHub pointer, what the scanner keys upstream facts by, and what the gallery links to.
// Undefined for any host that isn't GitHub, which is a listing we simply carry no stars for.
export const githubRepoOf = (install: RegistryInstall | undefined): string | undefined => {
    if (install === undefined) {
        return undefined;
    }
    const match = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(install.url);
    return match === null ? undefined : `${match[1]}/${match[2]}`;
};
