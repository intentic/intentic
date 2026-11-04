import { topPath } from "@intentic/sandbox-contract/app-routes";
import type { RouteLocationRaw } from "vue-router";

const LOGIN = topPath(`login`);

// Where a sign-in goes and returns to, for every guarded route in the app; getting it wrong is invisible
// since the user still ends up signed in, just not where they were headed.
export const signInAt = (fullPath: string): RouteLocationRaw =>
    fullPath === topPath(`root`) || fullPath.startsWith(LOGIN) ? LOGIN : { path: LOGIN, query: { returnTo: fullPath } };

// Destination read off the sign-in URL; must be a plain rooted path on this origin. Used as a router
// target and as `origin + this` for Better Auth's OAuth callback, so protocol-relative values (`//host`, `/\\host`) are
// refused. So is any control character: the URL parser drops a tab or a newline, which turns `/\t/host` into `//host`
// after this check has passed it.
const CONTROL = /[\u0000-\u001f\u007f]/u;
export const returnPath = (returnTo: unknown): string =>
    typeof returnTo === `string` && /^\/(?![/\\])/.test(returnTo) && !CONTROL.test(returnTo) ? returnTo : `/`;
