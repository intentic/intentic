// In production every lazy view's CSS is extracted into the initial stylesheet; this virtual module gives dev the same
// stable style set before the app mounts.
import { installDevStyles } from "virtual:intentic-dev-styles";
import { installChunkRecovery, installUi, isStaleChunkError, recoverStaleChunk } from "@intentic/ui";
import { setDeveloperBuild } from "@intentic/ui/motion";
import { highlightInWorker } from "@intentic/ui/markdown";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { computed, createApp } from "vue";
import App from "./App.vue";
import { startAppI18n } from "./app/i18n";
import { initAnalytics } from "./app/analytics";
import { sandboxAnalyticsGate } from "./features/sandbox/agent-settings/safety/analyticsGate";
import { useAuth } from "./client/auth/useAuth";
import { startAudienceSync } from "./client/sandbox/audienceSync";
import { dropOutdatedMirrors } from "./app/buildEpoch";
import { dropTranscriptStore } from "./features/chat/transcript/transcriptCache";
import { describeError, installClientDiagnostics, reportClient, sendClientDiagnosticsWith } from "./app/clientDiagnostics";
import { postClientDiagnostics } from "./client/sandbox/clientReport";
import { localFace } from "./app/environments/local";
import { installDesktopLinks, installDesktopOpener } from "./app/environments/desktop";
import { installPerfConsole, installPerfReporter, observeLongFrames } from "./app/perf/perf";
import { watchStalledQueries } from "./app/perf/queryStalls";
import { installRenderTrace } from "./app/perf/renderTrace";
import { queryClient } from "./lib/queryPersistence";
import { installSkeletonPersistence } from "./lib/skeletonPersistence";
import { installSelfHeal, purgeIfMarked, reportStartupError } from "./app/selfHeal";
import { installDocumentAppearance } from "./features/settings/documentAppearance";
import "./features/sandbox/switching/sandboxScope";
import "./features/sandbox/switching/sandboxScreen";
import "./extension-host/hostModules";
import { coreViews } from "./core-views/coreViews";
import { provideBuiltinViews } from "./workbench/views/registry";
import { openInPage, router } from "./router";
import { routePatternOf } from "./router/routePattern";
import { installNotificationTaps } from "./workbench/notifications/notificationTaps";
import "./styles.css";

installDevStyles();

// The views the app builds in join the registry extensions register into; it sits below them, so they are handed in.
provideBuiltinViews(coreViews);

// Called first: a startup crash after this wipes stored state and reloads once, not needing 'clear site data'.
installSelfHeal();
// Called right after selfHeal, so the wipe below is captured in the crash record too; reports reach the daemon through
// its client, handed in since diagnostics sit below it. A window on a folder of the user's own disk has no daemon behind
// it, only the files sidecar, which keeps no log: there a report has nowhere to go, and is dropped as one with no sandbox.
if (localFace() === undefined) {
    sendClientDiagnosticsWith(postClientDiagnostics);
}
installClientDiagnostics();
await purgeIfMarked();
dropOutdatedMirrors(dropTranscriptStore);

// Runs in every window; must follow the purge, so a wipe here is never misread as a preference.
installDocumentAppearance();

// Spinners and the thinking mark turn on the compositor everywhere but a developer's build under a desktop pointer,
// which keeps SMIL so an open DevTools Styles editor is not rebuilt with every request (useCompositedLoops).
setDeveloperBuild(import.meta.env.DEV);

// Code blocks in chat and documents are coloured in a worker, off the thread a reader's taps land on (code.ts).
highlightInWorker();

// Runs in every window too, and does nothing outside the desktop app: there, `target="_blank"` reaches the app only
// because of this.
installDesktopLinks();
// Also the app's alone: a loaded workspace is taken to a sandbox picked in a local window without a reload.
installDesktopOpener(openInPage);

// Loads the SDK only after consent and the page's first idle moment (analytics.ts).
void initAnalytics(
    (path) => routePatternOf(router, path),
    useAuth().user,
    sandboxAnalyticsGate(computed(() => String(router.currentRoute.value.name ?? ``))),
);

// Before mount, so a slow first paint's spans land in the ring buffer too (`__intenticPerf` in the console).
installPerfConsole();
// Durable copy of only the SLOW spans; handed in since perf.ts must not import back into the app's graph.
// Keyed by the op alone, so the reporter's per-kind cap holds: with the milliseconds in the message every slow frame of
// a streaming reply was a new kind, and a slow phone sent the queue's whole allowance every few seconds.
installPerfReporter((op, _ms, fields, requestId) =>
    reportClient(`perf.slow`, `slow ${op}`, { level: `warn`, fields, ...(requestId !== undefined ? { requestId } : {}) }),
);
// A frame that held the page past what a reader feels, with the scripts that held it (perf.ts, observeLongFrames).
observeLongFrames((fields) => reportClient(`perf.frame`, `long frame`, { level: `warn`, fields: { ...fields } }));
// A read that never settles, which no slow span can name since a span is filed only when the call ends (queryStalls.ts).
watchStalledQueries(queryClient);

// Push taps and app launches, routed in the open page; before mount, so a launch tap is never dropped unheard.
installNotificationTaps(router);

// Every window reads which words to use (developer or maker) from the sandbox once it answers, so two devices agree.
startAudienceSync();

// The reader's language, fetched before a single component renders in the wrong one. On `en` this resolves in the
// same tick; on any other language it is one chunk, and paying for it here is what buys a first paint that is
// already correct instead of one that corrects itself.
await startAppI18n();

// Loading placeholders drawn in their content's last shape remember it per sandbox, in IndexedDB; before anything
// mounts, so the first placeholder already reads the active sandbox's.
installSkeletonPersistence();

// Minimal app-wide wiring: router, PrimeVue, vue-query; server state in useQuery, client state in composables.
const app = createApp(App);
// Logs with Vue's `info` context rather than white-screening; during startup a render error signals a poisoned blob, so
// self-heal turns it into a wipe + reload.
app.config.errorHandler = (err, _instance, info) => {
    console.error(`[vue] ${info}:`, err);
    // Durable record for whoever actually hit it, not just whoever's watching; `info` carries the diagnosis.
    const { message, fields } = describeError(err);
    reportClient(`vue.${info.replace(/\s+/g, `-`)}`, message, { fields });
    // A render that threw because this tab now runs two builds at once (a view loaded after the dev server re-bundled
    // its dependencies, against the new bundle) left that view blank, and nothing in the view can repair it: the one
    // reload onto this page that a dead chunk gets (loadChunk) is the fix here too.
    // Once per page, as there: a second one on the same page is left to the paths below.
    if (isStaleChunkError(err) && recoverStaleChunk()) {
        return;
    }
    reportStartupError(err);
};
// Dev-only and idle until armed from the console; `import.meta.env.DEV` is compile-time, so the hook and the module
// behind it leave a production build entirely. So do the WebMCP tools an agent's browser calls (shell/agentDevTools.ts),
// imported rather than bundled so nothing of them reaches a production chunk.
if (import.meta.env.DEV) {
    const render = installRenderTrace(app);
    void import("./shell/agentDevTools").then(({ installAgentDevTools }) => installAgentDevTools(render));
}
app.use(router);
// Our own client so requireAuth can hydrate it from IndexedDB (per-user) before any route mounts.
app.use(VueQueryPlugin, { queryClient });
installUi(app);
// Every lazy chunk goes through `loadChunk`; this catches the preload Vite fails for one that doesn't.
installChunkRecovery();
app.mount("#app");
