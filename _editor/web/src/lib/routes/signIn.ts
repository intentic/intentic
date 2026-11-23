import { returnPath, topPath } from "@intentic/sandbox-contract/app-routes";
import type { RouteLocationRaw } from "vue-router";

const LOGIN = topPath(`login`);

// Where a sign-in goes and returns to, for every guarded route in the app; getting it wrong is invisible
// since the user still ends up signed in, just not where they were headed.
export const signInAt = (fullPath: string): RouteLocationRaw =>
    fullPath === topPath(`root`) || fullPath.startsWith(LOGIN) ? LOGIN : { path: LOGIN, query: { returnTo: fullPath } };

// Destination read off the sign-in URL or the sign-in mail's link: a plain rooted path on this origin, else `/`. The one
// rule the platform also checks it by before it writes it into the mail (sandbox-contract's app-routes).
export { returnPath };
