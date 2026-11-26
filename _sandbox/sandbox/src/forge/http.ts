import { throwOn } from "./refusals.js";

// The call shape only, not `typeof fetch`: a test's stand-in answers requests, it does not carry fetch's own statics.
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const githubHeaders = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" });
export const gitlabHeaders = (token: string): Record<string, string> => ({ "PRIVATE-TOKEN": token });

export const readJson = <T = unknown>(response: Response): Promise<T> => response.json() as Promise<T>;
export const json = async <T>(response: Response, what: string): Promise<T> => readJson<T>(await throwOn(response, what));

// What a POST to a forge's API sends, as JSON.
type ForgeJson = string | number | boolean | null | readonly ForgeJson[] | { readonly [key: string]: ForgeJson | undefined };
export type ForgeBody = { readonly [key: string]: ForgeJson | undefined };

export const posted = (headers: Record<string, string>, body?: ForgeBody): RequestInit =>
    body === undefined
        ? { method: "POST", headers }
        : { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) };

export const postTo = async (fetchFn: FetchFn, url: string, headers: Record<string, string>, what: string, body?: ForgeBody): Promise<void> => {
    await throwOn(await fetchFn(url, posted(headers, body)), what);
};
