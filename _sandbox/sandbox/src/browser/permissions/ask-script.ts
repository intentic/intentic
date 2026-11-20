import { z } from "zod";
import { parseJsonWith } from "@intentic/base/json";

// The script every page of a window runs before its own (page-asks.ts installs it), which turns a site's permission asks
// into calls this daemon answers. Chromium's own prompt for these is a bubble anchored to its toolbar, which the picture
// never shows, so an ask that reached it waited forever on a question nobody could see. Each wrapped call reports
// through a DevTools binding (Runtime.addBinding, taken off the page's global as this runs, so no page script can reach
// it by name) and waits on the answer, which the daemon gives back by calling `reply` in the same frame:
//
// - Notification.requestPermission: asks, and answers what was decided ("granted", "denied", "default" for none).
// - navigator.geolocation: asks before the browser's own lookup runs; a refusal reaches the error callback as
//   PERMISSION_DENIED, as Chromium's own would.
// - navigator.clipboard.read/readText: asks, then reads, or rejects with NotAllowedError.
// - navigator.mediaDevices.getUserMedia (and the prefixed getUserMedia): the sandbox has no camera or microphone, so it
//   is told so at once (NotFoundError, what Chromium answers with no device) and the person is told it happened.
// - A notification shown (new Notification, showNotification) is reported, for the person to see as one of Intentic's.
//
// A call made while a permission is already decided round-trips too: the daemon answers it at once from its store.
// What each wrapper's toString says is Chromium's own text for the function it replaced, so a page reading it sees
// native code, as the stealth script does for its own patches (sessions/stealth.ts).

export interface AskScriptNames {
    // The binding the page reports through.
    readonly binding: string;
    // The non-enumerable function the daemon answers through.
    readonly reply: string;
}

// The page's end of the binding: `ask` waits on an answer, `send` only reports, `patch` swaps a function for its wrapper.
const prelude = (names: AskScriptNames): string => `
  // The one place a throw is let go: what the page itself made throw (a frozen global, its own callback) must never
  // break the page, so the wrapped call goes on as it would have without the wrapper, and 'otherwise' is what it
  // answers instead.
  // allow(silent-catch): page-side, where nothing is listening and a thrown error would be the page's to see
  const quietly = (work, otherwise) => { try { return work(); } catch { return otherwise; } };
  const call = globalThis[${JSON.stringify(names.binding)}];
  if (typeof call !== 'function') return;
  quietly(() => delete globalThis[${JSON.stringify(names.binding)}]);
  const pending = new Map();
  let next = 0;
  const replying = quietly(() => Object.defineProperty(globalThis, ${JSON.stringify(names.reply)}, {
    value: (id, answer) => { const settle = pending.get(id); if (settle) { pending.delete(id); settle(answer); } },
    enumerable: false, configurable: false, writable: false,
  }), false);
  if (replying === false) return;
  const send = (message) => quietly(() => { call(JSON.stringify(message)); return true; }, false);
  const ask = (permission) => new Promise((resolve) => {
    next += 1;
    const id = next;
    pending.set(id, resolve);
    if (!send({ type: 'ask', id, permission })) { pending.delete(id); resolve('default'); }
  });
  const native = (fn, name) => {
    quietly(() => Object.defineProperty(fn, 'toString', { value: () => 'function ' + name + '() { [native code] }', configurable: true }));
    return fn;
  };
  const patch = (target, name, make) => quietly(() => {
    const original = target && target[name];
    if (typeof original === 'function') target[name] = native(make(original), name);
  });
  const refused = (name) => new DOMException(name === 'NotFoundError' ? 'Requested device not found' : 'Permission denied', name);

`;

// Notifications: the ask, and each one shown once allowed.
const NOTIFICATIONS = `
  if (typeof Notification === 'function') {
    patch(Notification, 'requestPermission', () => function requestPermission(callback) {
      return ask('notifications').then((answer) => {
        if (typeof callback === 'function') quietly(() => callback(answer));
        return answer;
      });
    });
    quietly(() => {
      const Original = Notification;
      globalThis.Notification = new Proxy(Original, {
        construct(target, args, newTarget) {
          const made = Reflect.construct(target, args, newTarget);
          if (Original.permission === 'granted') {
            send({ type: 'notify', title: String(args[0] ?? ''), body: String((args[1] && args[1].body) ?? '') });
          }
          return made;
        },
      });
    });
  }
  if (typeof ServiceWorkerRegistration === 'function') {
    patch(ServiceWorkerRegistration.prototype, 'showNotification', (original) => function showNotification(title, options) {
      const shown = original.apply(this, arguments);
      if (typeof Notification === 'function' && Notification.permission === 'granted') {
        send({ type: 'notify', title: String(title ?? ''), body: String((options && options.body) ?? '') });
      }
      return shown;
    });
  }

`;

// Location: asked before the browser's own lookup runs.
const GEOLOCATION = `
  if (typeof Geolocation === 'function') {
    const proto = Geolocation.prototype;
    const denied = (error) => {
      if (typeof error === 'function') {
        quietly(() => error({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
      }
    };
    patch(proto, 'getCurrentPosition', (original) => function getCurrentPosition(success, error, options) {
      ask('geolocation').then((answer) => answer === 'granted' ? original.call(this, success, error, options) : denied(error));
    });
    // A watch's id is answered at once, before the ask is: it stands for the real watch once there is one.
    const watches = new Map();
    let watchIds = 0;
    const clear = proto.clearWatch;
    patch(proto, 'watchPosition', (original) => function watchPosition(success, error, options) {
      watchIds += 1;
      const id = watchIds;
      watches.set(id, undefined);
      ask('geolocation').then((answer) => {
        if (!watches.has(id)) return;
        if (answer === 'granted') watches.set(id, original.call(this, success, error, options));
        else { watches.delete(id); denied(error); }
      });
      return id;
    });
    patch(proto, 'clearWatch', () => function clearWatch(id) {
      if (!watches.has(id)) return;
      const real = watches.get(id);
      watches.delete(id);
      if (real !== undefined && typeof clear === 'function') clear.call(this, real);
    });
  }

`;

// Reading the clipboard, and the camera and microphone the sandbox does not have.
const CLIPBOARD_AND_DEVICES = `
  if (typeof Clipboard === 'function') {
    for (const name of ['read', 'readText']) {
      patch(Clipboard.prototype, name, (original) => function () {
        const args = arguments;
        return ask('clipboard-read').then((answer) => answer === 'granted' ? original.apply(this, args) : Promise.reject(refused('NotAllowedError')));
      });
    }
  }

  const noDevice = (constraints) => {
    const wantsVideo = !!(constraints && constraints.video);
    send({ type: 'unavailable', permission: wantsVideo ? 'camera' : 'microphone' });
    return refused('NotFoundError');
  };
  if (typeof MediaDevices === 'function') {
    patch(MediaDevices.prototype, 'getUserMedia', () => function getUserMedia(constraints) {
      return Promise.reject(noDevice(constraints));
    });
  }
  for (const name of ['getUserMedia', 'webkitGetUserMedia']) {
    patch(Navigator.prototype, name, () => function (constraints, success, error) {
      const failure = noDevice(constraints);
      if (typeof error === 'function') quietly(() => error(failure));
    });
  }
`;

/** The init script, with this page's binding and reply names. */
export const askScript = (names: AskScriptNames): string =>
    `(() => {${prelude(names)}${NOTIFICATIONS}${GEOLOCATION}${CLIPBOARD_AND_DEVICES}})();\n`;

// One message the page sent, as the daemon reads it: anything else a page could put through the binding is dropped. A
// notification's words are cut short enough for a lock screen; a page cannot hand the person a novel.
const AskMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ask"), id: z.number().int().nonnegative(), permission: z.enum(["notifications", "geolocation", "clipboard-read"]) }),
    z.object({ type: z.literal("unavailable"), permission: z.enum(["camera", "microphone"]) }),
    z.object({
        type: z.literal("notify"),
        title: z.string().transform((text) => text.slice(0, 120)),
        body: z.string().transform((text) => text.slice(0, 400)),
    }),
]);

export type AskMessage = z.output<typeof AskMessageSchema>;

/** Reads one binding payload; undefined for anything that is not one of the three messages above. */
export const parseAskMessage = (payload: string): AskMessage | undefined => parseJsonWith(payload, AskMessageSchema);
