import { start } from "monaco-editor-core/esm/vs/editor/editor.worker.start.js";

/* The editor worker's entry point, a module that exists to be loaded ON the worker thread (useMonaco imports
 * it with Vite's `?worker`) and whose only job is the start() call below.
 *
 * monaco-editor-core ships `editor.worker.start.js` as a LIBRARY: it exports start() and never calls it (the
 * self-starting entry lives in the `monaco-editor` package, which we don't ship). Handing that module to the
 * worker directly therefore produced a worker that installed no `onmessage` handler and answered nothing,
 * and since the diff algorithm runs there, every diff request went into a void that never replied. The diff
 * editor then rendered two plain panes: no red/green lines, no minimap or overview-ruler marks, and no
 * collapsed unchanged regions, because none of those exist until the diff comes back.
 *
 * No foreign module (start's argument builds one): that hook is for a custom language worker's own methods,
 * and we ship none. Shiki tokenizes on the main thread and there is no IntelliSense. */
start(() => null);
