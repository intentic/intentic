// Every module of this package, loaded by walking src/ rather than through index.ts, so what reads the package's whole
// surface (the lock, the daemon's shape seed) sees every module whether or not the barrel re-exports it. The list comes
// from src/ even when this runs from dist/, since a dist/ file whose source is gone is never cleaned away.

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "@intentic/constants/node";

// Package-relative to src/, forward slashes, without the extension: the specifier after `@intentic/sandbox-contract/`.
export type ContractModuleId = string;

const sourceModules = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sourceModules(path);
        }
        return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
    });

// What one module exports, by name.
export type ContractModuleExports = ReadonlyMap<string, unknown>;

// Each module's exports by id, in id order; `index` is left out, being what this walk stands in for.
export const contractModules = async (): Promise<ReadonlyMap<ContractModuleId, ContractModuleExports>> => {
    const root = packageRoot(import.meta.url);
    const source = join(root, "src");
    const fromSource = import.meta.url.endsWith(".ts");
    const ids = sourceModules(source)
        .map((path) => relative(source, path).replaceAll("\\", "/").replace(/\.ts$/, ""))
        .filter((id) => id !== "index")
        .toSorted();
    const modules = new Map<ContractModuleId, ContractModuleExports>();
    for (const id of ids) {
        const file = fromSource ? join(source, `${id}.ts`) : join(root, "dist", `${id}.js`);
        const namespace: object = await import(pathToFileURL(file).href);
        modules.set(id, new Map(Object.entries(namespace)));
    }
    return modules;
};
