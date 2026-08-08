/// <reference types="vite/client" />

interface ImportMetaEnv {
    // Stamped by vite.shared's define, one fresh value per build. Absent under vitest (which shares only the
    // aliases, not the define), where buildId() falls back to a constant.
    readonly BUILD_ID?: string;
}

/* monaco-editor-core types only its public surface (monaco.d.ts); the worker bootstrap it ships alongside it is
 * plain JS with no declaration. start() installs the worker thread's message handler and takes a factory for the
 * foreign (custom language worker) module — see composables/workspace/editorWorker.ts, the only caller. */
declare module "monaco-editor-core/esm/vs/editor/editor.worker.start.js" {
    export function start(createClient: (ctx: unknown) => unknown): unknown;
}
