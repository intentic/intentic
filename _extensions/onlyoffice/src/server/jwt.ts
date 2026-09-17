import { createHmac, timingSafeEqual } from "node:crypto";

// HS256 JSON Web Tokens, the one algorithm ONLYOFFICE Docs signs and checks with. Node builtins only: this bundle runs
// with nothing else.

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

const hmac = (signingInput: string, secret: string): Buffer => createHmac("sha256", secret).update(signingInput).digest();

export const signJwt = (payload: Record<string, unknown>, secret: string): string => {
    const signingInput = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;
    return `${signingInput}.${hmac(signingInput, secret).toString("base64url")}`;
};

const parseSegment = (segment: string): Record<string, unknown> | undefined => {
    try {
        const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
};

// The payload of a token this secret signed with HS256, else undefined: a wrong algorithm, a bad signature and a
// malformed token all answer the same way.
export const verifyJwt = (token: string, secret: string): Record<string, unknown> | undefined => {
    const [header, body, signature, ...rest] = token.split(".");
    if (header === undefined || body === undefined || signature === undefined || rest.length > 0) {
        return undefined;
    }
    if (parseSegment(header)?.["alg"] !== "HS256") {
        return undefined;
    }
    const expected = hmac(`${header}.${body}`, secret);
    const presented = Buffer.from(signature, "base64url");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return undefined;
    }
    return parseSegment(body);
};

// The token in an `Authorization: Bearer …` header, else undefined.
export const bearerOf = (header: string | undefined): string | undefined => {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
    return match?.[1];
};
