import type { WatchCheckAnswer } from "@intentic/extension-api";
import { maxSatisfying, validRange } from "semver";
import { z } from "zod";
import { type CheckFetch, timedFetch } from "./watch-http.js";

// The `npm` watch kind (intentic-extension.json `watchKinds`): the registry's view of one package. With a `range`, the
// check passes once a published version satisfies it, and what it saw is that version; without, what it saw is the
// version under `tag` (latest by default), for `fireOn: change`. Moved from the daemon (2026-11-26) with the same
// parameters, so a watch stored before reads the same.

const NpmParamsSchema = z.object({ package: z.string().min(1), range: z.string().optional(), tag: z.string().optional() });

// A scoped name keeps its @ and escapes its slash, the registry's own spelling.
const registryUrl = (name: string): string =>
    `https://registry.npmjs.org/${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;

const PackumentSchema = z.object({
    "dist-tags": z.record(z.string(), z.string()).optional(),
    versions: z.record(z.string(), z.unknown()).optional(),
});
type Packument = z.infer<typeof PackumentSchema>;

const byRange = (name: string, range: string, packument: Packument): WatchCheckAnswer => {
    const match = maxSatisfying(Object.keys(packument.versions ?? {}), range);
    if (match !== null) {
        return { pass: true, output: `${name}@${match}` };
    }
    const latest = packument["dist-tags"]?.["latest"];
    return { pass: false, detail: `no published version of ${name} satisfies ${range} yet${latest === undefined ? "" : ` (latest is ${latest})`}` };
};

/** One check of an npm watch. */
export const checkNpm = async (params: Readonly<Record<string, string | boolean>>, fetch: CheckFetch, signal?: AbortSignal): Promise<WatchCheckAnswer> => {
    const parsed = NpmParamsSchema.safeParse(params);
    if (!parsed.success) {
        return { pass: false, detail: "an npm watch names a package, and optionally a range or a tag" };
    }
    const { package: name, range, tag } = parsed.data;
    if (range !== undefined && validRange(range) === null) {
        return { pass: false, detail: `"${range}" is not a semver range npm understands, like >=1.4.3 or ^2` };
    }
    // The abbreviated document: dist-tags and the version list, without every version's readme.
    const fetched = await timedFetch(fetch, registryUrl(name), { accept: "application/vnd.npm.install-v1+json" }, signal);
    if ("unreachable" in fetched) {
        return { pass: false, detail: fetched.unreachable };
    }
    const { response } = fetched;
    if (response.status === 404) {
        return { pass: false, detail: `npm has no package named ${name}` };
    }
    if (!response.ok) {
        return { pass: false, detail: `the npm registry answered ${response.status}` };
    }
    const packument = PackumentSchema.safeParse(await response.json());
    if (!packument.success) {
        return { pass: false, detail: `the npm registry answered something other than ${name}'s package document` };
    }
    if (range !== undefined) {
        return byRange(name, range, packument.data);
    }
    const version = packument.data["dist-tags"]?.[tag ?? "latest"];
    return version === undefined ? { pass: false, detail: `${name} has no "${tag ?? "latest"}" tag` } : { pass: true, output: `${name}@${version}` };
};
