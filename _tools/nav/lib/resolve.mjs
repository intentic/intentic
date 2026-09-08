// Follows an imported name past barrel re-exports to the file that defines it, not the facade. Builds each file's
// export table once, then follows `export { x } from` and `export * from` edges. A name it cannot follow is reported
// unresolved, never guessed at.
import { dirname, join, normalize } from "node:path";

const EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".vue", ".mjs", ".js"];

// Workspace package name → directory, read from tracked package.json files; without it a monorepo import can't resolve.
export const packageMap = (root, files, read) => {
    const map = new Map();
    for (const path of files) {
        if (!path.endsWith("package.json") || path.includes("node_modules/")) {
            continue;
        }
        try {
            const parsed = JSON.parse(read(root, path));
            if (typeof parsed.name === "string" && parsed.name !== "") {
                map.set(parsed.name, dirname(path));
            }
        } catch {
            // An unparsable package.json is skipped, not attributed to a package.
        }
    }
    return map;
};

const candidates = (base) => {
    const out = [];
    // `./foo.js` in source resolves to `./foo.ts` on disk, per this repo's ESM convention.
    const stripped = base.replace(/\.(m?)js$/u, "");
    for (const extension of EXTENSIONS) {
        out.push(stripped + extension);
    }
    for (const extension of EXTENSIONS) {
        out.push(join(stripped, `index${extension}`));
    }
    out.push(base);
    return out;
};

// Resolves one specifier from one file to a tracked path, or "" when it leaves the tree (expected for third-party
// imports like `node:fs`).
export const resolveSpecifier = (fromPath, specifier, known, packages) => {
    if (specifier.startsWith(".")) {
        const base = normalize(join(dirname(fromPath), specifier));
        for (const candidate of candidates(base)) {
            if (known.has(candidate)) {
                return candidate;
            }
        }
        return "";
    }

    // A workspace package, possibly with a subpath, e.g. `@intentic/sandbox/agent`.
    for (const [name, dir] of packages) {
        if (specifier !== name && !specifier.startsWith(`${name}/`)) {
            continue;
        }
        const subpath = specifier === name ? "" : specifier.slice(name.length + 1);
        const bases =
            subpath === "" ? [join(dir, "src", "index"), join(dir, "index"), join(dir, "src")] : [join(dir, "src", subpath), join(dir, subpath)];
        for (const base of bases) {
            for (const candidate of candidates(base)) {
                if (known.has(candidate)) {
                    return candidate;
                }
            }
        }
        return "";
    }
    return "";
};

// `facts` is path → moduleFactsOf output; `defines` is path → Set of names declared there. A depth cap and visited set
// stop mutually re-exporting barrels from hanging the follow.
export const makeResolver = ({ facts, defines, known, packages }) => {
    const memo = new Map();

    const follow = (path, name, seen, depth) => {
        if (depth > 12 || seen.has(`${path}\u0000${name}`)) {
            return "";
        }
        seen.add(`${path}\u0000${name}`);

        const fileFacts = facts.get(path);
        if (!fileFacts) {
            return "";
        }

        // Defined right here: done.
        if (defines.get(path)?.has(name)) {
            return path;
        }

        // Re-exported by name from somewhere specific.
        for (const entry of fileFacts.reexports) {
            if (entry.name !== name) {
                continue;
            }
            const next = resolveSpecifier(path, entry.from, known, packages);
            if (next) {
                const found = follow(next, entry.sourceName, seen, depth + 1);
                if (found) {
                    return found;
                }
            }
        }

        // `export * from`: first star target to define the name wins; duplicates across stars are invalid TypeScript.
        for (const star of fileFacts.stars) {
            const next = resolveSpecifier(path, star, known, packages);
            if (next) {
                const found = follow(next, name, seen, depth + 1);
                if (found) {
                    return found;
                }
            }
        }

        // Imported and re-exported in two statements: `import { x } from "./a"; export { x };`
        if (fileFacts.localExports.includes(name)) {
            for (const entry of fileFacts.imports) {
                const match = entry.names.find((n) => n.local === name);
                if (!match) {
                    continue;
                }
                const next = resolveSpecifier(path, entry.specifier, known, packages);
                if (next) {
                    const found = follow(next, match.imported, seen, depth + 1);
                    if (found) {
                        return found;
                    }
                }
            }
        }

        return "";
    };

    return (fromPath, specifier, name) => {
        const key = `${fromPath}\u0000${specifier}\u0000${name}`;
        const cached = memo.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const entry = resolveSpecifier(fromPath, specifier, known, packages);
        const answer = entry ? follow(entry, name, new Set(), 0) : "";
        memo.set(key, answer);
        return answer;
    };
};
