import { registerCatalog, startI18n } from "@intentic/ui/i18n";
import { appCatalog } from "@intentic/web/app/i18n";
import { createApp } from "vue";
import { installShareUi } from "./boot";
import { registerShareCatalog } from "./i18n";
import ShareApp from "./ShareApp.vue";
import "./styles.css";

/* The published page's boot, and, by what it does NOT do, most of what makes this page safe to hand a stranger. */

// This page's own words, and the editor's: the chat components it compiles in are the app's, and their labels are
// keys in the app's catalog.
await Promise.all([registerShareCatalog(), registerCatalog(appCatalog)]);

// A stranger's browser decides the language here — this page stores no preference and asks for no choice, so the
// negotiation falls through to `navigator.languages`. Awaited before mount, so the page never paints twice.
await startI18n();

const app = createApp(ShareApp);
installShareUi(app);
app.mount(`#app`);
