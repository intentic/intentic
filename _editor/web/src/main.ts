// In production every lazy view's CSS is extracted into the initial stylesheet; this virtual module gives dev the same
// stable style set before the app mounts.
import { installDevStyles } from "virtual:intentic-dev-styles";
import { installChunkRecovery, installUi } from "@intentic/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { createApp } from "vue";
import App from "./App.vue";
import { startAppI18n } from "./app/i18n";
import { initAnalytics } from "./app/analytics";
import { dropOutdatedMirrors } from "./app/buildEpoch";
import { describeError, installClientDiagnostics, reportClient } from "./app/clientDiagnostics";
import { installDesktopLinks } from "./app/environments/desktop";
import { installPerfConsole, installPerfReporter } from "./app/perf";
import { installRenderTrace } from "./app/renderTrace";
import { queryClient } from "./lib/queryPersistence";
import { installSelfHeal, purgeIfMarked, reportStartupError } from "./app/selfHeal";
import { installDocumentAppearance } from "./features/settings/documentAppearance";
import "./features/sandbox/client/sandboxScope";
import "./features/sandbox/client/sandboxScreen";
import "./extension-host/hostModules";
import { router } from "./router";
import { installNotificationTaps } from "./shell/notifications/notificationTaps";
import "./styles.css";

installDevStyles();

// Called first: a startup crash after this wipes stored state and reloads once, not needing 'clear site data'.
installSelfHeal();
// Called right after selfHeal, so the wipe below is captured in the crash record too.
installClientDiagnostics();
await purgeIfMarked();
dropOutdatedMirrors();

// Runs in every window; must follow the purge, so a wipe here is never misread as a preference.
installDocumentAppearance();

// Runs in every window too, and does nothing outside the desktop app: there, `target="_blank"` reaches the app only
// because of this.
installDesktopLinks();

initAnalytics();

// Before mount, so a slow first paint's spans land in the ring buffer too (`__intenticPerf` in the console).
installPerfConsole();
// Durable copy of only the SLOW spans; handed in since perf.ts must not import back into the app's graph.
installPerfReporter((_op, _ms, fields, requestId) =>
    reportClient(`perf.slow`, `slow ${fields["op"]} ${fields["ms"]}ms`, { level: `warn`, fields, ...(requestId !== undefined ? { requestId } : {}) }),
);

// iOS shell only (no-op elsewhere); must precede mount so a launch tap isn't dropped before a listener exists.
installNotificationTaps(router);

// The reader's language, fetched before a single component renders in the wrong one. On `en` this resolves in the
// same tick; on any other language it is one chunk, and paying for it here is what buys a first paint that is
// already correct instead of one that corrects itself.
await startAppI18n();

// Minimal app-wide wiring: router, PrimeVue, vue-query; server state in useQuery, client state in composables.
const app = createApp(App);
// Logs with Vue's `info` context rather than white-screening; during startup a render error signals a poisoned blob, so
// self-heal turns it into a wipe + reload.
app.config.errorHandler = (err, _instance, info) => {
    console.error(`[vue] ${info}:`, err);
    // Durable record for whoever actually hit it, not just whoever's watching; `info` carries the diagnosis.
    const { message, fields } = describeError(err);
    reportClient(`vue.${info.replace(/\s+/g, `-`)}`, message, { fields });
    reportStartupError(err);
};
// Dev-only and idle until armed from the console; `import.meta.env.DEV` is compile-time, so the hook and the module
// behind it leave a production build entirely.
if (import.meta.env.DEV) {
    installRenderTrace(app);
}
app.use(router);
// Our own client so requireAuth can hydrate it from IndexedDB (per-user) before any route mounts.
app.use(VueQueryPlugin, { queryClient });
installUi(app);
// Every lazy chunk goes through `loadChunk`; this catches the preload Vite fails for one that doesn't.
installChunkRecovery();
app.mount("#app");
