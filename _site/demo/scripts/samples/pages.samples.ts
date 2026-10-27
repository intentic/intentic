import { STATE_DIR } from "@intentic/constants";
import type { GroupSamples } from "./context.ts";

// The recording's one stored page: not an MCP server's app, so the app call is refused in the daemon's words.
const PAGE = `${STATE_DIR}/records/artifacts/pages/cnv_priya_payouts/7c1e9a2b4f.r0.html`;

export const pagesSamples: GroupSamples<`pages`> = () => ({
    appCall: { page: PAGE, name: `list_payouts` },
    reportErrors: { page: PAGE, errors: [`TypeError: rows is undefined\n    at draw (page.js:12:5)`] },
});
