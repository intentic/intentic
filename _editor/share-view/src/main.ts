import { startI18n } from "@intentic/ui/i18n";
import { createApp } from "vue";
import { installShareUi } from "./boot";
import ShareApp from "./ShareApp.vue";
import "./styles.css";

/* The published page's boot, and, by what it does NOT do, most of what makes this page safe to hand a stranger. */

// A stranger's browser decides the language here — this page stores no preference and asks for no choice, so the
// negotiation falls through to `navigator.languages`. Awaited before mount, so the page never paints twice.
await startI18n();

const app = createApp(ShareApp);
installShareUi(app);
app.mount(`#app`);
