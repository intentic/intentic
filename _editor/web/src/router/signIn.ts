import type { RouteLocationRaw } from "vue-router";

// Where a sign-in goes and returns to, for every guarded route in the app; getting it wrong is invisible
// since the user still ends up signed in, just not where they were headed.
export const signInAt = (fullPath: string): RouteLocationRaw =>
    fullPath === `/` || fullPath.startsWith(`/login`) ? `/login` : { path: `/login`, query: { returnTo: fullPath } };

// Destination read off the sign-in URL; must be a plain rooted path on this origin. Used as a router
// target and as `origin + this` for Better Auth's OAuth callback, so protocol-relative values (`//host`, `/\\host`) are
// refused.
export const returnPath = (returnTo: unknown): string => (typeof returnTo === `string` && /^\/(?![/\\])/.test(returnTo) ? returnTo : `/`);
