import { fileBody } from "../../fixture/workspace";

// The fields of a package.json the workspace's readers use: who it is, what made it, and what it depends on.
export interface PackageManifest {
    readonly name?: string;
    readonly intentic?: { readonly template?: string };
    readonly scripts?: Readonly<Record<string, string>>;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
    readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** The manifest at `path`, or undefined when there is none or it does not parse, as a reader on disk would skip it. */
export const readManifest = (path: string): PackageManifest | undefined => {
    const body = fileBody(path);
    if (body === undefined) {
        return undefined;
    }
    try {
        // SAFETY: only the optional fields above are read, each checked for presence where it is used.
        return JSON.parse(body) as PackageManifest;
    } catch {
        // allow(silent-catch): a manifest that does not parse is skipped, as the daemon's readers skip it on disk.
        return undefined;
    }
};
