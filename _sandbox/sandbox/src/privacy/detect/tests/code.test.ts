import { PERSONAL_DATA_CLASSES } from "@intentic/sandbox-contract";
import { detectPersonalData } from "../detect.js";

// Most of what an agent reads is code and tool output, and the model must read it as it is: a masked identifier, hash
// or timestamp would cost it the very thing it is working on. Each text below is the kind of file or output a session
// is full of, and none of it holds anyone's personal data, so every class together must find nothing.

const everything = new Set(PERSONAL_DATA_CLASSES);
const finds = (text: string): string[] => detectPersonalData(text, { classes: everything }).map((span) => `${span.class}:${span.value}`);

const TYPESCRIPT = `import { readFile } from "node:fs/promises";
import type { Request, Response } from "express";
import { Adam, SGD } from "./optimizers/index.js";
import { Victoria } from "@charts/victoria";

// Mark the entry as done. Will retry on failure; Max attempts below.
export const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface Person {
    readonly firstName: string;
    readonly lastName: string;
    readonly email?: string;
}

export class Grace extends Map<string, Person> {
    private readonly optimizer = new Adam({ lr: 0.001 });

    async load(path: string): Promise<void> {
        const raw = await readFile(path, "utf8");
        for (const row of JSON.parse(raw) as Person[]) {
            this.set(row.lastName, row);
        }
        console.log(\`Loaded \${this.size} rows in \${Date.now() - start}ms\`);
    }
}

export const handler = async (req: Request, res: Response) => {
    const id = req.params["id"] ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
        return res.status(400).json({ error: "Invalid id", code: 40012 });
    }
    return res.json({ ok: true, retryAfter: 1727786400 });
};
`;

const PACKAGE_JSON = `{
    "name": "@intentic/sandbox",
    "version": "0.0.0",
    "description": "Remote AI-agent dev workspace daemon, runs inside a per-project sandbox container on the customer's host",
    "license": "MIT",
    "author": "Intentic",
    "type": "module",
    "repository": { "type": "git", "url": "git+https://github.com/intentic/intentic.git", "directory": "_sandbox/sandbox" },
    "scripts": { "build": "tsgo && tsgo -p tsconfig.bench.json", "test": "suites", "dev": "tsx watch ./src/main.ts" },
    "dependencies": { "@hono/node-server": "^1.13.7", "zod": "4.1.12", "lodash": "4.17.21", "mermaid": "11.12.0" },
    "packageManager": "pnpm@10.18.3",
    "engines": { "node": ">=24.0.0" }
}
`;

const GIT_LOG = `3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39 1727786400 fix: handle Adam optimizer state on resume
a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 1727700000 feat: Grace period for expired sessions
9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807 1727613600 chore(deps): bump vite from 5.4.8 to 5.4.10
commit 0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c
Author: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>
Date:   Mon Jan 5 14:02:11 2026 +0100

    Bump the npm group across 1 directory with 3 updates
`;

const UUIDS = `123e4567-e89b-12d3-a456-426614174000
550e8400-e29b-41d4-a716-446655440000
6ba7b810-9dad-11d1-80b4-00c04fd430c8
00000000-0000-0000-0000-000000000000
85010112-3456-7890-1234-567890123456
`;

const INSTALL_LOG = `Progress: resolved 1342, reused 1290, downloaded 52, added 1342, done
node_modules/.pnpm/esbuild@0.24.0/node_modules/esbuild: Running postinstall script, done in 412ms
 WARN  deprecated inflight@1.0.6: This module is not supported, and leaks memory.
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.100.200:5173/
build/assets/index-4f8a2c1b.js   142.31 kB │ gzip: 45.12 kB
✓ built in 3.21s
Error: ENOENT: no such file or directory, open '/home/runner/work/app/Anna/config.json'
    at Object.openSync (node:fs:573:18)
    at Module._compile (node:internal/modules/cjs/loader:1504:14)
`;

const PYTHON = `from torch.optim import Adam
import numpy as np

class Julia:
    """Mark points where Will meets the boundary."""

    def __init__(self, seed: int = 1234567890) -> None:
        self.rng = np.random.default_rng(seed)
        self.optimizer = Adam(self.parameters(), lr=3e-4)

    def run(self, steps=10_000):
        return [self.rng.integers(0, 600100200) for _ in range(steps)]
`;

describe("code and tool output", () => {
    test("a TypeScript module", () => {
        expect(finds(TYPESCRIPT)).toEqual([]);
    });

    test("a package.json", () => {
        expect(finds(PACKAGE_JSON)).toEqual([]);
    });

    test("a git log with hashes and unix timestamps", () => {
        expect(finds(GIT_LOG)).toEqual([]);
    });

    test("a list of UUIDs, one of them made of digits only", () => {
        expect(finds(UUIDS)).toEqual([]);
    });

    test("an install and build log with paths, versions and addresses", () => {
        expect(finds(INSTALL_LOG)).toEqual([]);
    });

    test("a Python module", () => {
        expect(finds(PYTHON)).toEqual([]);
    });
});
