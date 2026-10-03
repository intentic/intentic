import { cardOrder, cardStatus, type DeviceSandboxGroup, filesLine, idleHere, portsLine } from "@intentic/ui/device";

// A sandbox card's closed face (_editor/ui/src/components/sandbox/deviceDetail.ts): where it stands in a word, the
// Files and Ports lines in plain words with each warning on the line it is about, and the order a machine's list is
// read in, with the leftovers of sandboxes that live elsewhere set apart.

const running = (sandboxId: string, extra: Partial<DeviceSandboxGroup> = {}): DeviceSandboxGroup => ({
    sandboxId,
    title: sandboxId,
    sandbox: { slug: sandboxId, running: true, image: `img` },
    ports: [],
    ...extra,
});

const elsewhere = (sandboxId: string, folder: DeviceSandboxGroup[`folder`], ports: DeviceSandboxGroup[`ports`] = []): DeviceSandboxGroup => ({
    sandboxId,
    title: sandboxId,
    folder,
    ports,
});

it(`says where a sandbox stands in a word, an interrupted update as the warning it is`, () => {
    expect(cardStatus(running(`a`), false)).toMatchObject({ variant: `success`, label: `running` });
    expect(cardStatus(running(`a`), true)).toMatchObject({ variant: `info`, label: `working…` });
    expect(cardStatus({ ...running(`a`), sandbox: { slug: `a`, running: false, image: `img`, parked: true } }, false)).toMatchObject({
        variant: `warning`,
        label: `Interrupted update`,
    });
    expect(cardStatus(elsewhere(`b`, undefined), false)).toMatchObject({ variant: `neutral`, label: `not running here` });
});

it(`puts the folder on the Files line with only the news beside it`, () => {
    const folder = { sandboxId: `a`, mode: `sync` as const, localDir: `/home/ada/a`, mutagenStatus: `watching` };
    expect(filesLine(running(`a`, { folder })).map((part) => part.text)).toEqual([`/home/ada/a`]);
    expect(filesLine(running(`a`, { folder: { ...folder, paused: true } })).map((part) => part.text)).toEqual([`/home/ada/a`, `paused`]);
    expect(filesLine(running(`a`, { folder: { ...folder, conflicts: 3 } })).map((part) => [part.text, part.tone])).toEqual([
        [`/home/ada/a`, `content`],
        [`3 conflicts`, `warning`],
    ]);
    expect(filesLine(running(`a`)).map((part) => part.text)).toEqual([`not synced to this computer`]);
    // Paired with no session: the path alone would read as a folder in step.
    expect(filesLine(running(`a`, { folder: { sandboxId: `a`, mode: `sync`, localDir: `/home/ada/a` } })).map((part) => part.text)).toEqual([
        `/home/ada/a`,
        `not syncing`,
    ]);
});

it(`names the addresses that reached localhost and counts the rest by outcome`, () => {
    const folder = { sandboxId: `a`, mode: `sync` as const, localDir: `/home/ada/a`, mutagenStatus: `watching` };
    const ports = [5173, 3000, 8080, 9229].map((port) => ({ port, sandboxId: `a`, state: `mirrored` as const }));
    expect(
        portsLine(
            running(`a`, {
                folder,
                ports: [
                    ...ports,
                    // The IPv6 twin of 5173 is the same address to the reader.
                    { port: 5173, sandboxId: `a`, state: `mirrored`, host: `::1` },
                    { port: 5440, sandboxId: `a`, state: `busy` },
                    { port: 6379, sandboxId: `a`, state: `held-by-sandbox`, heldBy: `b` },
                ],
            }),
        )?.map((part) => [part.text, part.tone]),
    ).toEqual([
        [`localhost:5173`, `content`],
        [`localhost:3000`, `content`],
        [`localhost:8080`, `content`],
        [`+1 more`, `muted`],
        [`1 taken by another sandbox`, `warning`],
        [`1 busy here`, `muted`],
    ]);
    expect(portsLine(running(`a`, { folder: { ...folder, mirroring: `off` }, ports }))?.map((part) => part.text)).toEqual([`mirroring off`]);
    expect(portsLine(running(`a`, { folder }))?.map((part) => part.text)).toEqual([`nothing served yet`]);
    // Nothing paired and nothing held: no Ports line at all, since nothing here could reach localhost.
    expect(portsLine(running(`a`))).toBeUndefined();
});

// The rog case: six folders of sandboxes that run elsewhere, or no longer do, all paused. A laptop syncing a hosted
// sandbox is the other case, and its row is the point of the page, so it stays a card.
it(`sets apart only the leftovers that do nothing here`, () => {
    const paused = elsewhere(`gone`, { sandboxId: `gone`, mode: `sync`, localDir: `/home/ada/gone`, paused: true, mutagenStatus: `watching` });
    const sessionless = elsewhere(`stale`, { sandboxId: `stale`, mode: `sync`, localDir: `/home/ada/stale` });
    const live = elsewhere(`hosted`, { sandboxId: `hosted`, mode: `sync`, localDir: `/home/ada/hosted`, mutagenStatus: `watching` });
    const portsOnly = elsewhere(`ports`, { sandboxId: `ports`, mode: `mirror` }, [{ port: 3000, sandboxId: `ports`, state: `mirrored` }]);
    const conflicted = elsewhere(`stuck`, { sandboxId: `stuck`, mode: `sync`, localDir: `/home/ada/stuck`, paused: true, conflicts: 2 });
    expect([paused, sessionless, live, portsOnly, conflicted].map(idleHere)).toEqual([true, true, false, false, false]);
    expect(idleHere(running(`here`))).toBe(false);
});

it(`reads the list as the caller's own sandbox, what runs, what is stopped, what syncs from elsewhere, then the idle`, () => {
    const stopped: DeviceSandboxGroup = { sandboxId: `stopped`, title: `stopped`, sandbox: { slug: `stopped`, running: false, image: `img` }, ports: [] };
    const live = elsewhere(`hosted`, { sandboxId: `hosted`, mode: `sync`, localDir: `/home/ada/hosted`, mutagenStatus: `watching` });
    const gone = elsewhere(`gone`, { sandboxId: `gone`, mode: `sync`, localDir: `/home/ada/gone`, paused: true });
    const bands = cardOrder([gone, live, stopped, running(`one`), running(`mine`)], [`mine`]);
    expect(bands.active.map((group) => group.sandboxId)).toEqual([`mine`, `one`, `stopped`, `hosted`]);
    expect(bands.idle.map((group) => group.sandboxId)).toEqual([`gone`]);
});
