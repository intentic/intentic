/* In production every lazy view's CSS is extracted into the initial stylesheet. The shared Vite config gives
 * development the same stable style set through this style-only virtual module, before the app mounts. */
import { installDevStyles } from "virtual:intentic-dev-styles";
import { installUi } from "@intentic/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { createApp } from "vue";
import App from "./App.vue";
import { initAnalytics } from "./composables/analytics";
import { dropOutdatedMirrors } from "./composables/buildEpoch";
import { describeError, installClientDiagnostics, reportClient } from "./composables/clientDiagnostics";
import { installPerfConsole, installPerfReporter } from "./composables/perf";
import { queryClient } from "./composables/queryPersistence";
import { installSelfHeal, purgeIfMarked, reportStartupError } from "./composables/selfHeal";
import { installDocumentAppearance } from "./composables/theme/documentAppearance";
// Registers the module-level watch that re-scopes chat / editor / file-action state on sandbox switch.
import "./composables/sandbox/sandboxScope";
// …and the one that remembers each sandbox's screen, so a switch lands where that sandbox was left.
import "./composables/sandbox/sandboxScreen";
// Publishes the app's vue + extension-api instances for extension bundles (see the import map in index.html).
import "./extension-host/hostModules";
import { router } from "./router";
import { installNotificationTaps } from "./shell/notificationTaps";
import "./styles.css";

installDevStyles();

// First: from here on, a startup crash wipes this origin's stored state and reloads once instead of leaving a
// workspace only "clear site data" can fix (see selfHeal.ts). Then the two ordered steps a previous page may
// have left for this one: the wipe it marked (awaited, every mirror below must find the deletes done), and
// the build-change drop of mirrors no restore gate covers (buildEpoch.ts).
installSelfHeal();
// Right after it: the same window's crashes now also leave a durable record, and the wipe below is one of the
// things worth recording (composables/clientDiagnostics.ts).
installClientDiagnostics();
await purgeIfMarked();
dropOutdatedMirrors();

/* The whole-document look, installed for THIS window: the scheme, the base text size, the skin and any imported
 * VSCode theme. Here rather than in whatever page happens to read one, because a preference that paints <html>
 * has to be declared in every window of the app or it is neither applied nor live there, which is what left a
 * popped-out chat frozen in the theme it was opened with (composables/theme/documentAppearance.ts). After the
 * purge above, so a wipe this page was asked to perform is never read back as a preference. */
installDocumentAppearance();

initAnalytics();

// Before anything mounts, so the spans of a slow first paint are in the ring buffer too. `__intenticPerf` in
// the console is the whole interface, see composables/perf.ts.
installPerfConsole();
/* And a durable copy of the SLOW ones. Handed in rather than imported by perf.ts, which sits under the daemon
 * client and must not point back into the app's graph (installPerfReporter says why). Only the slow spans
 * leave the browser: every span still lands in the ring buffer, and a durable copy of all of them would be
 * hundreds of lines a second during a streaming turn. */
installPerfReporter((_op, _ms, fields, requestId) =>
    reportClient(`perf.slow`, `slow ${fields["op"]} ${fields["ms"]}ms`, { level: `warn`, fields, ...(requestId !== undefined ? { requestId } : {}) }),
);

// Inside the native iOS shell only (a no-op everywhere else): the tap that launched the app is queued until a
// listener exists, so this must precede the mount to land the user where the notification pointed.
installNotificationTaps(router);

// Composition API + a single design-system plugin. No zone.js / providers ceremony: the router, PrimeVue
// (via installUi), and vue-query are the only app-wide wiring; server state lives in useQuery/useMutation,
// client state in composables (see composables/).
const app = createApp(App);
// A render/lifecycle error in one component must never white-screen the shell or vanish without a trace: log
// it with Vue's context (info names the hook, e.g. "render function") so it's diagnosable. The offending
// subtree stops updating; the rest of the app lives on, unless this is still the startup window, where a
// render error is how a poisoned hydrated blob first bites, and self-heal turns it into a wipe + one reload.
app.config.errorHandler = (err, _instance, info) => {
    console.error(`[vue] ${info}:`, err);
    // …and somewhere it survives the reload. The console line is for whoever is watching; this is for everyone
    // else, which is almost always who actually hit it (composables/clientDiagnostics.ts). `info` names the
    // hook, which is most of the diagnosis on a render error whose message names nothing.
    const { message, fields } = describeError(err);
    reportClient(`vue.${info.replace(/\s+/g, `-`)}`, message, { fields });
    reportStartupError(err);
};
app.use(router);
// Our own client so requireAuth can hydrate it from IndexedDB (per-user) before any route mounts.
app.use(VueQueryPlugin, { queryClient });
installUi(app);
app.mount("#app");
