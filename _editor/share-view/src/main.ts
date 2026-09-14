import { createApp } from "vue";
import { installShareUi } from "./boot";
import ShareApp from "./ShareApp.vue";
import "./styles.css";

/* The published page's boot, and, by what it does NOT do, most of what makes this page safe to hand a stranger. */

const app = createApp(ShareApp);
installShareUi(app);
app.mount(`#app`);
