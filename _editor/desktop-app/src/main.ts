import { installUi } from "@intentic/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createApp } from "vue";
import App from "./App.vue";
import CloseConfirm from "./CloseConfirm.vue";
import "./styles.css";

/* Two windows into one bundle. The launcher face is the app's own screens; the confirmation the × raises is a
 * dialog with nothing in common with them (windows.rs), so the window's LABEL picks which one mounts, read
 * off metadata the webview is created with rather than asked for over IPC, because a dialog about a click that
 * has already happened cannot wait for a round trip before it draws. */
const app = createApp(getCurrentWindow().label === `confirm-close` ? CloseConfirm : App);
app.config.errorHandler = (error, _instance, info) => {
    console.error(`[vue] ${info}:`, error);
};
installUi(app);
app.mount(`#app`);
