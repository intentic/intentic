import { diagnose, type Diagnostic } from "./diag.js";
import { createProjectDeps, findTsconfig, openProject, type Project, type ProjectDeps } from "./project.js";

/* The warm side of the language service — the thing a daemon holds open between requests.
 *
 * Cold, `lsp diag one-file.ts` cost ~1.7s: parse the tsconfig, build a LanguageService, pull lib.d.ts and every
 * root file through the compiler, answer one question, exit. That whole program is thrown away and rebuilt for
 * the next edit. Keeping it resident turns the SECOND and every later question into an incremental re-check of
 * the files that actually changed, which is what makes post-edit diagnostics cheap enough to run on every edit.
 *
 * Three things are shared across the projects in a workspace and are the reason this is one object rather than a
 * map of independent services:
 *   - one ts.DocumentRegistry, so lib.d.ts and shared node_modules types are parsed once for the whole monorepo
 *     instead of once per package;
 *   - one version map, so a file edited in one package invalidates its snapshot in every package that includes it
 *     (a monorepo's cross-package imports are exactly the breakages worth catching);
 *   - one marker store, so a reader can ask "what is wrong with this file right now" without paying for a check.
 *
 * `touched` is the only invalidation signal. The caller knows precisely which files changed — the agent's own
 * PostToolUse edit, or a watcher — which beats polling mtimes on a monorepo's worth of roots. */

interface Marker {
    readonly diagnostics: readonly Diagnostic[];
    // The workspace generation these were computed in — NOT the file's own version. A file's diagnostics depend
    // on every file it imports, so an edit anywhere can break it without touching it; keying the cache on a
    // workspace-wide counter is what makes cross-file breakage surface. Re-checking is cheap because the program
    // is warm and the language service only recomputes what actually moved.
    readonly generation: number;
}

export class Workspace {
    private readonly deps: ProjectDeps = createProjectDeps();
    // tsconfig path (or the file's own path when it belongs to no project) -> its resident service.
    private readonly projects = new Map<string, Project>();
    private readonly markers = new Map<string, Marker>();
    // Files whose diagnostics are worth keeping current: everything anyone has asked about or edited. The
    // analogue of VS Code's open buffers — tsserver only validates what is open, never the whole program.
    private readonly open = new Set<string>();
    private generation = 0;

    private version(file: string): number {
        return this.deps.versions.get(file) ?? 0;
    }

    // The resident project for a file, built on first use. Keyed by tsconfig so every file in a package shares
    // one service; a file with no tsconfig gets a single-file project keyed by its own path.
    private projectFor(file: string): Project {
        const tsconfig = findTsconfig(file);
        const key = tsconfig ?? file;
        const existing = this.projects.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const project = openProject(tsconfig, file, this.deps);
        this.projects.set(key, project);
        return project;
    }

    // Mark files as changed. Bumping the version is what makes the language service re-read them on the next
    // question; the markers computed against the old version stay in the map but now read as stale.
    touched(files: readonly string[]): void {
        if (files.length === 0) {
            return;
        }
        for (const file of files) {
            this.deps.versions.set(file, this.version(file) + 1);
            this.open.add(file);
        }
        this.generation += 1;
    }

    // Diagnostics for these files, computed now against the warm program. Results are cached by version, so
    // asking twice without an intervening edit costs nothing.
    diagnose(files: readonly string[]): Diagnostic[] {
        const out: Diagnostic[] = [];
        for (const file of files) {
            this.open.add(file);
            const cached = this.fresh(file);
            if (cached !== undefined) {
                out.push(...cached);
                continue;
            }
            // A project that cannot be built (an unreadable tsconfig) must not take the daemon down with it —
            // the file simply has no diagnostics we can vouch for.
            const diagnostics = this.tryDiagnose(file);
            this.markers.set(file, { diagnostics, generation: this.generation });
            out.push(...diagnostics);
        }
        return out;
    }

    private tryDiagnose(file: string): Diagnostic[] {
        try {
            return diagnose(this.projectFor(file), [file]);
        } catch {
            return [];
        }
    }

    // What we already know about a file, or undefined when nothing current is on hand. This is the read a hook
    // wants: if the debounced recompute has already run, the answer costs a map lookup.
    fresh(file: string): readonly Diagnostic[] | undefined {
        const cached = this.markers.get(file);
        return cached !== undefined && cached.generation === this.generation ? cached.diagnostics : undefined;
    }

    // Bring every open file's markers up to date. The daemon calls this on a debounce after edits land, so the
    // answer is usually already sitting in the map by the time anything asks for it.
    refresh(): void {
        for (const file of this.open) {
            if (this.fresh(file) === undefined) {
                this.markers.set(file, { diagnostics: this.tryDiagnose(file), generation: this.generation });
            }
        }
    }
}
