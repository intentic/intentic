// In production every lazy view's CSS is extracted into the initial stylesheet; this virtual module gives dev the same
// stable style set before the app mounts.
import { installDevStyles } from "virtual:intentic-dev-styles";
import { installUi } from "@intentic/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { createApp } from "vue";
import App from "./App.vue";
import { initAnalytics } from "./app/analytics";
import { dropOutdatedMirrors } from "./app/buildEpoch";
import { describeError, installClientDiagnostics, reportClient } from "./app/clientDiagnostics";
import { installPerfConsole, installPerfReporter } from "./app/perf";
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

initAnalytics();

// Before mount, so a slow first paint's spans land in the ring buffer too (`__intenticPerf` in the console).
installPerfConsole();
// Durable copy of only the SLOW spans; handed in since perf.ts must not import back into the app's graph.
installPerfReporter((_op, _ms, fields, requestId) =>
    reportClient(`perf.slow`, `slow ${fields["op"]} ${fields["ms"]}ms`, { level: `warn`, fields, ...(requestId !== undefined ? { requestId } : {}) }),
);

// iOS shell only (no-op elsewhere); must precede mount so a launch tap isn't dropped before a listener exists.
installNotificationTaps(router);

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
app.use(router);
// Our own client so requireAuth can hydrate it from IndexedDB (per-user) before any route mounts.
app.use(VueQueryPlugin, { queryClient });
installUi(app);
app.mount("#app");
