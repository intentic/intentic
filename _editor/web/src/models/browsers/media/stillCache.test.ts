// The tabs' last pictures: held by key, capped by bytes, the least recently used let go of (and closed) first.
import { stillCache } from "./stillCache";

const picture = (width: number, height: number) => {
    const made = { width, height, closed: false, close: () => (made.closed = true) };
    return made;
};

// 100x100 RGBA is 40 000 bytes; the cap below holds two.
const CAP = 80_000;

it("keeps pictures by key and hands one back", () => {
    const cache = stillCache<ReturnType<typeof picture>>(CAP);
    const one = picture(100, 100);
    cache.put(`a`, one);
    expect(cache.take(`a`)).toBe(one);
    expect(cache.take(`b`)).toBeUndefined();
    expect(cache.bytes()).toBe(40_000);
});

it("lets go of the least recently used past its cap, closing it", () => {
    const cache = stillCache<ReturnType<typeof picture>>(CAP);
    const [a, b, c] = [picture(100, 100), picture(100, 100), picture(100, 100)];
    cache.put(`a`, a);
    cache.put(`b`, b);
    // Using `a` makes `b` the oldest.
    cache.take(`a`);
    cache.put(`c`, c);
    expect(cache.keys()).toEqual([`a`, `c`]);
    expect(b.closed).toBe(true);
    expect(a.closed).toBe(false);
    expect(cache.bytes()).toBe(80_000);
});

it("closes the picture a key held when it is given another", () => {
    const cache = stillCache<ReturnType<typeof picture>>(CAP);
    const [old, next] = [picture(100, 100), picture(50, 50)];
    cache.put(`a`, old);
    cache.put(`a`, next);
    expect(old.closed).toBe(true);
    expect(cache.bytes()).toBe(10_000);
});

it("keeps no picture larger than its whole cap, and empties on clear", () => {
    const cache = stillCache<ReturnType<typeof picture>>(CAP);
    const huge = picture(200, 200);
    const small = picture(10, 10);
    cache.put(`small`, small);
    cache.put(`huge`, huge);
    expect(huge.closed).toBe(true);
    expect(cache.keys()).toEqual([`small`]);
    cache.clear();
    expect(small.closed).toBe(true);
    expect(cache.bytes()).toBe(0);
});
