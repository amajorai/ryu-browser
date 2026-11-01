/** Private document-start observer. No capability is exposed as a page property. */
export function createBrowserActivityInitScript(capability: string): string {
	return `(() => {
"use strict";
const capability = ${JSON.stringify(capability)};
const binding = window.__ryuBrowserActivity;
if (typeof binding !== "function" || !navigator.mediaDevices) return;
const apply = Reflect.apply;
const define = Object.defineProperty;
const create = Object.create;
const descriptor = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const hasOwn = Object.prototype.hasOwnProperty;
const stringify = JSON.stringify;
const then = Promise.prototype.then;
const promiseConstructor = Promise;
const species = Symbol.species;
const promiseSpecies = create(null);
define(promiseSpecies, species, { value: promiseConstructor });
const tracks = MediaStream.prototype.getTracks;
const cloneStream = MediaStream.prototype.clone;
const trackPrototype = MediaStreamTrack.prototype;
const ready = descriptor(trackPrototype, "readyState").get;
const trackKind = descriptor(trackPrototype, "kind").get;
const settings = trackPrototype.getSettings;
const clone = trackPrototype.clone;
const stop = trackPrototype.stop;
const addEvent = EventTarget.prototype.addEventListener;
const interval = window.setInterval;
const records = [];
let nextId = 0;
const sourceId = (track) => {
  const value = apply(settings, track, []);
  if (apply(hasOwn, value, ["displaySurface"])) return "screen:" + value.displaySurface;
  return apply(hasOwn, value, ["deviceId"]) && typeof value.deviceId === "string" ? value.deviceId : "";
};
const notify = (action, kind, trackId, source) => {
  const payload = create(null);
  payload.capability = capability;
  payload.action = action;
  payload.kind = kind;
  payload.trackId = trackId;
  payload.sourceId = source;
  binding(stringify(payload));
};
const liveKind = (track, fallback) => {
  const value = apply(settings, track, []);
  if (apply(hasOwn, value, ["displaySurface"])) return "screen";
  return fallback ?? (apply(trackKind, track, []) === "audio" ? "microphone" : "camera");
};
const observe = (track, kind, action = "start") => {
  if (apply(ready, track, []) !== "live") return;
  for (let i = 0; i < records.length; i++) if (records[i].track === track) return;
  const record = { track, kind, id: ++nextId, ended: false, source: sourceId(track) };
  define(records, records.length, { value: record, writable: true, configurable: true });
  const finish = () => {
    // Synthetic 'ended' events and shadowed JS properties do not stop a device.
    if (record.ended || apply(ready, track, []) !== "ended") return;
    record.ended = true;
    notify("stop", kind, record.id, record.source);
  };
  apply(addEvent, track, ["ended", finish]);
  define(track, "stop", { configurable: true, writable: true, value: function(...args) {
    const result = apply(stop, track, args);
    finish();
    return result;
  }});
  notify(action, kind, record.id, record.source);
};
const observeStream = (stream, fallback) => {
  const list = apply(tracks, stream, []);
  for (let i = 0; i < list.length; i++) observe(list[i], liveKind(list[i], fallback));
  return stream;
};
define(MediaStream.prototype, "clone", { configurable: true, writable: true, value: function(...args) {
  const copied = apply(cloneStream, this, args);
  const list = apply(tracks, copied, []);
  for (let i = 0; i < list.length; i++) {
    // Native stream cloning does not call the JavaScript track.clone wrapper.
    // Only device/display tracks count: remote WebRTC and generated tracks do not.
    observe(list[i], liveKind(list[i]), "clone");
  }
  return copied;
}});
define(trackPrototype, "clone", { configurable: true, writable: true, value: function(...args) {
  const copied = apply(clone, this, args);
  let kind;
  for (let i = 0; i < records.length; i++) if (records[i].track === this) kind = records[i].kind;
  // Borrowed cross-frame clone methods still observe local capture devices.
  const value = apply(settings, this, []);
  if (kind || apply(hasOwn, value, ["deviceId"]) || apply(hasOwn, value, ["displaySurface"])) {
    observe(copied, liveKind(copied, kind), "clone");
  }
  return copied;
}});
const methodOwner = (receiver, method) => {
  for (let owner = receiver; owner; owner = prototypeOf(owner)) {
    if (apply(hasOwn, owner, [method])) return owner;
  }
  return receiver;
};
const monitor = (method, fallback) => {
  const owner = methodOwner(navigator.mediaDevices, method);
  const original = owner[method];
  if (typeof original !== "function") return;
  define(owner, method, { configurable: true, writable: true, value: function(...args) {
    const pending = apply(original, this, args);
    // Keep species/constructor getters supplied by the page out of our observer.
    define(pending, "constructor", { value: promiseSpecies });
    return apply(then, pending, [(stream) => observeStream(stream, fallback)]);
  }});
};
monitor("getUserMedia");
monitor("getDisplayMedia", "screen");
for (const method of ["getUserMedia", "webkitGetUserMedia"]) {
  const owner = methodOwner(navigator, method);
  const original = owner[method];
  if (typeof original !== "function") continue;
  define(owner, method, { configurable: true, writable: true, value: function(constraints, success, failure) {
    return apply(original, this, [constraints, (stream) => {
      observeStream(stream);
      if (typeof success === "function") success(stream);
    }, failure]);
  }});
}
apply(interval, window, [() => {
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record.ended && apply(ready, record.track, []) === "ended") {
      record.ended = true;
      notify("stop", record.kind, record.id, record.source);
    }
  }
}, 500]);
})();`;
}
