import { createApp } from "vue";
import { installShareUi } from "./boot";
import ShareApp from "./ShareApp.vue";
import "./styles.css";

/* The published page's boot, and, by what it does NOT do, most of what makes this page safe to hand a
 * stranger. There is no router, no daemon client, no store, no sign-in and no configuration: the app is one
 * component over a conversation that is already in the document (payload.ts).
 *
 * The one piece of wiring is the design system's icon primitive and hover label, which the shared tool card
 * renders globally, see boot.ts for why that is a short list rather than the app's own `installUi`. */

const app = createApp(ShareApp);
installShareUi(app);
app.mount(`#app`);
