import { installUi } from "@intentic-app/ui";
import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";

const app = createApp(App);
app.config.errorHandler = (error, _instance, info) => {
    console.error(`[vue] ${info}:`, error);
};
installUi(app);
app.mount(`#app`);
