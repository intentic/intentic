// The name `ic` knows this sandbox by, which every command printed for its machine carries, found without the daemon:
// the container name the daemon last reported first, then the first label of its address on the platform's row, the
// same key `ic sandbox connect` took the container's name from.
import { servingSlug, slugOfDaemonUrl } from "./servingSlug";

it(`reads the slug off the daemon's address the way ic named the container`, () => {
    expect(slugOfDaemonUrl(`https://sandbox-3c469e9d6c58.intentic.dev`)).toBe(`sandbox-3c469e9d6c58`);
    expect(slugOfDaemonUrl(`https://Lab.example.com:8443/path`)).toBe(`lab`);
    expect(slugOfDaemonUrl(`not a url`)).toBeUndefined();
    expect(slugOfDaemonUrl(null)).toBeUndefined();
});

it(`prefers the container name the daemon reported over the address`, () => {
    expect(servingSlug(`intentic-sandbox-acme-shop`, `https://sandbox-3c469e9d6c58.intentic.dev`)).toBe(`acme-shop`);
    expect(servingSlug(undefined, `https://sandbox-3c469e9d6c58.intentic.dev`)).toBe(`sandbox-3c469e9d6c58`);
    // A server-managed sandbox's fixed container name names no slug; neither does a row with no address.
    expect(servingSlug(`intentic-sandbox`, null)).toBeUndefined();
});
