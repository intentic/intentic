import { installUi } from "@intentic/ui";
import { startI18n } from "@intentic/ui/i18n";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createApp } from "vue";
import App from "./App.vue";
import CloseConfirm from "./CloseConfirm.vue";
import "./styles.css";

// The reader's language, before a single component renders in the wrong one; `installUi` below installs `$t` itself.
await startI18n();

/* Two windows into one bundle. */
const app = createApp(getCurrentWindow().label === `confirm-close` ? CloseConfirm : App);
app.config.errorHandler = (error, _instance, info) => {
    console.error(`[vue] ${info}:`, error);
};
installUi(app);
app.mount(`#app`);
