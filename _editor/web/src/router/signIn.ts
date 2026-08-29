import type { RouteLocationRaw } from "vue-router";

/* WHERE A SIGN-IN GOES, AND WHERE IT COMES BACK TO.
 *
 * Its own module, and tested, for the reason setupGate.ts is: this is one decision taken on behalf of every
 * guarded route in the app, and getting it wrong is invisible — the user IS signed in afterwards, just not
 * where they were going. The guard used to redirect to a bare `/login`, and the login screen ends by pushing
 * into the workspace shell, so the page that asked for a session was simply forgotten.
 *
 * That is a nuisance for a deep link into settings and a broken product for /desktop-auth, whose URL carries
 * the state and challenge tying it to a desktop app waiting on a deep link. Losing them leaves the browser in
 * a signed-in workspace and the app still sitting on its own sign-in screen, with nothing to tell it
 * otherwise. (That page resolves its own session now and never comes through here, but the class of bug is
 * the same one the MCP flow already routes around with its own /connect page.) */
export const signInAt = (fullPath: string): RouteLocationRaw =>
    fullPath === `/` || fullPath.startsWith(`/login`) ? `/login` : { path: `/login`, query: { returnTo: fullPath } };

/* The destination read back off the sign-in screen's own URL, and it is ONLY ever a path on this origin.
 *
 * The value is spent two ways, and both are why this is narrow: vue-router navigates to it, and Better Auth
 * is handed `origin + this` as an OAuth callback. A `//host` or `/\host` is a protocol-relative URL to the
 * URL parser, so an unchecked query parameter here is an open redirect wearing a sign-in page — the one
 * screen where a user has been taught to expect Google. Anything that is not a plain rooted path is the
 * workspace, which is where this page went before it could carry a destination at all. */
export const returnPath = (returnTo: unknown): string => (typeof returnTo === `string` && /^\/(?![/\\])/.test(returnTo) ? returnTo : `/`);
