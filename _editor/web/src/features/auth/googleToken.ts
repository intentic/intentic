export interface IdTokenClaims {
    readonly email: string;
    readonly expiresAt: number;
}

// A Google credential must have the JWT shape and the two claims this app relies on. Unreadable input has no
// artificial lifetime: caching malformed data turns one bad handoff into thirty minutes of guaranteed 401s.
export const idTokenClaims = (jwt: string): IdTokenClaims | undefined => {
    try {
        const parts = jwt.split(`.`);
        if (parts.length !== 3 || parts.some((part) => part === ``)) {
            return undefined;
        }
        const payload = parts[1] ?? ``;
        const base64 = payload
            .replace(/-/g, `+`)
            .replace(/_/g, `/`)
            .padEnd(Math.ceil(payload.length / 4) * 4, `=`);
        const decoded = JSON.parse(atob(base64)) as { exp?: unknown; email?: unknown };
        if (typeof decoded.exp !== `number` || !Number.isFinite(decoded.exp) || typeof decoded.email !== `string` || decoded.email === ``) {
            return undefined;
        }
        return { email: decoded.email, expiresAt: decoded.exp * 1000 };
    } catch {
        return undefined;
    }
};
