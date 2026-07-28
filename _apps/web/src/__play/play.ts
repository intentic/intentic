import { installUi } from "@intentic-app/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { createApp } from "vue";
import "../styles.css";
import Play from "./Play.vue";

const app = createApp(Play);
installUi(app);
app.use(VueQueryPlugin);
app.mount(`#play`);
