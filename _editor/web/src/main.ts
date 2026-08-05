import { installUi } from "@intentic/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { createApp } from "vue";
import App from "./App.vue";
import { initAnalytics } from "./composables/analytics";
import { installPerfConsole } from "./composables/perf";
import { queryClient } from "./composables/queryPersistence";
// Registers the module-level watch that re-scopes chat / editor / file-action state on sandbox switch.
import "./composables/sandbox/sandboxScope";
// …and the one that remembers each sandbox's screen, so a switch lands where that sandbox was left.
import "./composables/sandbox/sandboxScreen";
// Publishes the app's vue + extension-api instances for extension bundles (see the import map in index.html).
import "./extension-host/hostModules";
import { router } from "./router";
import "./styles.css";

initAnalytics();
// Before anything mounts, so the spans of a slow first paint are in the ring buffer too. `__intenticPerf` in
// the console is the whole interface — see composables/perf.ts.
installPerfConsole();

// Composition API + a single design-system plugin. No zone.js / providers ceremony: the router, PrimeVue
// (via installUi), and vue-query are the only app-wide wiring; server state lives in useQuery/useMutation,
// client state in composables (see composables/).
const app = createApp(App);
// A render/lifecycle error in one component must never white-screen the shell or vanish without a trace: log
// it with Vue's context (info names the hook, e.g. "render function") so it's diagnosable. The offending
// subtree stops updating; the rest of the app lives on.
app.config.errorHandler = (err, _instance, info) => {
    console.error(`[vue] ${info}:`, err);
};
app.use(router);
// Our own client so requireAuth can hydrate it from IndexedDB (per-user) before any route mounts.
app.use(VueQueryPlugin, { queryClient });
installUi(app);
app.mount("#app");
