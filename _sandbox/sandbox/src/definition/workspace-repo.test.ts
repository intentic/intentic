import { githubLogin, type LoginLookupWarn } from "./workspace-repo.js";

// Publishing asks github who the token is only to choose between the user's and an organization's endpoint. A failed
// lookup once fell back to the organization's; it must again, and say why in the log rather than vanish.

const host = { apiBase: "https://api.github.test", token: "t" };

const collect = () => {
    const warned: string[] = [];
    const warn: LoginLookupWarn = (_fields, message) => void warned.push(message);
    return { warned, warn };
};

test("the token's own login is read off /user", async () => {
    const { warned, warn } = collect();
    const fetcher = async () => Response.json({ login: "radarsu" });
    expect(await githubLogin(host, warn, fetcher)).toBe("radarsu");
    expect(warned).toEqual([]);
});

test("a /user lookup that throws falls back to no login, logged", async () => {
    const { warned, warn } = collect();
    const fetcher = async (): Promise<Response> => await Promise.reject(new Error("ECONNRESET"));
    expect(await githubLogin(host, warn, fetcher)).toBeUndefined();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("organization");
});

test("a refused or unreadable /user answer falls back to no login, logged", async () => {
    const refused = collect();
    const forbidden = async () => new Response("no", { status: 403 });
    expect(await githubLogin(host, refused.warn, forbidden)).toBeUndefined();
    expect(refused.warned).toHaveLength(1);

    const garbled = collect();
    const notJson = async () => new Response("<html>", { status: 200 });
    expect(await githubLogin(host, garbled.warn, notJson)).toBeUndefined();
    expect(garbled.warned).toHaveLength(1);
});
