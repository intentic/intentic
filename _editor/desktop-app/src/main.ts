import { installUi } from "@intentic/ui";
import { startI18n } from "@intentic/ui/i18n";
import { createApp } from "vue";
import CloseConfirm from "./CloseConfirm.vue";
import { registerDesktopCatalog } from "./i18n";
import "./styles.css";

// The app's own bundle (index.html) draws one window now: the question the workspace's × asks (windows.rs
// `ask_before_closing`). Everything else the app shows is the editor, on this computer's folders (local/main.ts, the
// local face) or on the hosted workspace; This device, where the launcher's card used to be, is a page of the former.

// The reader's language, before a single component renders in the wrong one; `installUi` below installs `$t` itself.
// The shell's own words are registered first, so `startI18n` has them to fetch a language for.
await registerDesktopCatalog();
await startI18n();

const app = createApp(CloseConfirm);
app.config.errorHandler = (error, _instance, info) => {
    console.error(`[vue] ${info}:`, error);
};
installUi(app);
app.mount(`#app`);
