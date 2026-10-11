/// <reference types="vite/client" />

interface ImportMetaEnv {
    // Stamped by vite.shared's define, one fresh value per build. Absent under bun test (which shares only the
    // aliases, not the define), where buildId() falls back to a constant.
    readonly BUILD_ID?: string;
    // Stamped by vite.shared's devSource, on a dev server only: which checkout it serves and who started it.
    readonly DEV_SOURCE?: {
        readonly root: string;
        readonly branch: string | null;
        readonly startedBy: string | null;
        readonly startedAt: string;
    };
}

/* monaco-editor-core types only its public surface (monaco.d.ts); the worker bootstrap it ships alongside it is plain JS with no declaration. */
declare module "monaco-editor-core/esm/vs/editor/editor.worker.start.js" {
    export function start(createClient: (ctx: unknown) => unknown): unknown;
}
