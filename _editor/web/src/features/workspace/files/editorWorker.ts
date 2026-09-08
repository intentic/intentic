import { start } from "monaco-editor-core/esm/vs/editor/editor.worker.start.js";

// Worker entry point (Vite's `?worker`): calls start(), which editor.worker.start.js exports but never invokes (usually
// the unshipped monaco-editor package's job). No foreign module: that hook is for a custom language worker's own
// methods, none shipped (Shiki tokenizes main-thread, no IntelliSense).
start(() => null);
