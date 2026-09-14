import { installUi } from "@intentic/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createApp } from "vue";
import App from "./App.vue";
import CloseConfirm from "./CloseConfirm.vue";
import "./styles.css";

/* Two windows into one bundle. */
const app = createApp(getCurrentWindow().label === `confirm-close` ? CloseConfirm : App);
app.config.errorHandler = (error, _instance, info) => {
    console.error(`[vue] ${info}:`, error);
};
installUi(app);
app.mount(`#app`);
