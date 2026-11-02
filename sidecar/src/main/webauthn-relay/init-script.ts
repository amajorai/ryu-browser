/** Private CDP binding the page-side shim calls. */
export const WEBAUTHN_BINDING = "__ryuWebAuthn";
/** Non-writable page global the main process settles ceremonies through. */
export const WEBAUTHN_SETTLE = "__ryuWebAuthnSettle";

/**
 * Document-start shim for `navigator.credentials.get/create` with `publicKey`.
 *
 * It runs in the page's main world (WebAuthn has to be overridden where the
 * site calls it), takes the private binding and deletes it from `window`, and
 * only wraps the top-level document: frames keep Chromium's own WebAuthn.
 * Conditional mediation (passkey autofill) is left native too, so a page load
 * never raises a prompt on the user's desktop.
 *
 * Each call is serialized to the WebAuthn JSON form (every buffer base64url)
 * and sent with the per-tab capability. The main process validates it, builds
 * `clientDataJSON` from the tab's real origin, and later settles the promise
 * through `window.__ryuWebAuthnSettle(capability, id, json)`, which ignores any
 * caller without the capability.
 */
export function createWebAuthnInitScript(capability: string): string {
	return `(() => {
"use strict";
const capability = ${JSON.stringify(capability)};
const binding = window.${WEBAUTHN_BINDING};
try { delete window.${WEBAUTHN_BINDING}; } catch (_) { /* keep going */ }
if (typeof binding !== "function" || window.top !== window) return;
const PKC = window.PublicKeyCredential;
const Container = window.CredentialsContainer;
const container = navigator.credentials;
if (typeof PKC !== "function" || typeof Container !== "function" || !container) return;
const containerProto = Container.prototype;
const nativeGet = containerProto.get;
const nativeCreate = containerProto.create;
const apply = Reflect.apply;
const define = Object.defineProperty;
const create = Object.create;
const keys = Object.keys;
const stringify = JSON.stringify;
const parse = JSON.parse;
const isArray = Array.isArray;
const isView = ArrayBuffer.isView;
const tagOf = Object.prototype.toString;
const indexOf = String.prototype.indexOf;
const PromiseCtor = Promise;
const reject = (error) => apply(PromiseCtor.reject, PromiseCtor, [error]);
const DOMExceptionCtor = window.DOMException;
const Bytes = Uint8Array;
const protoOf = (name) => typeof window[name] === "function" ? window[name].prototype : Object.prototype;
const assertionProto = protoOf("AuthenticatorAssertionResponse");
const attestationProto = protoOf("AuthenticatorAttestationResponse");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const pending = create(null);
let nextId = 0;

const pageError = (name, message) => name === "TypeError"
  ? new TypeError(message)
  : new DOMExceptionCtor(message, name);
const notAllowed = (message) => pageError("NotAllowedError", message);
const abortError = (signal) => signal.reason !== undefined
  ? signal.reason
  : pageError("AbortError", "The operation was aborted.");
const encode = (bytes) => {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const n = (bytes[i] << 16) | (rest === 2 ? bytes[i + 1] << 8 : 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    if (rest === 2) out += ALPHABET[(n >> 6) & 63];
  }
  return out;
};
const decode = (text) => {
  if (typeof text !== "string") throw new TypeError("expected base64url");
  const bytes = new Bytes((text.length * 3) >> 2);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < text.length; i++) {
    const value = apply(indexOf, ALPHABET, [text[i]]);
    if (value < 0) throw new TypeError("expected base64url");
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.buffer;
};
const bytesOf = (value) => {
  if (isView(value)) return new Bytes(value.buffer, value.byteOffset, value.byteLength);
  if (apply(tagOf, value, []) === "[object ArrayBuffer]") return new Bytes(value);
  return null;
};
const toJSONValue = (value, depth) => {
  if (depth > 8) throw new TypeError("publicKey options are nested too deeply");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object") return undefined;
  const bytes = bytesOf(value);
  if (bytes) return encode(bytes);
  if (isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const item = toJSONValue(value[i], depth + 1);
      define(out, i, { value: item === undefined ? null : item, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  const out = create(null);
  const names = keys(value);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name === "signal") continue;
    const item = toJSONValue(value[name], depth + 1);
    if (item !== undefined) out[name] = item;
  }
  return out;
};
const send = (fields) => {
  const payload = create(null);
  payload.capability = capability;
  const names = keys(fields);
  for (let i = 0; i < names.length; i++) payload[names[i]] = fields[names[i]];
  binding(stringify(payload));
};
const value = (target, name, item) => define(target, name, { value: item, enumerable: true, configurable: true });
const method = (target, name, fn) => define(target, name, { value: fn, configurable: true, writable: true });

const buildCredential = (data) => {
  const response = data.response;
  const json = () => {
    const out = { clientDataJSON: data.clientDataJSON };
    if (response.kind === "assertion") {
      out.authenticatorData = response.authenticatorData;
      out.signature = response.signature;
      if (response.userHandle) out.userHandle = response.userHandle;
    } else {
      out.attestationObject = response.attestationObject;
      out.transports = response.transports.slice();
      if (response.authenticatorData) out.authenticatorData = response.authenticatorData;
      if (response.publicKey) out.publicKey = response.publicKey;
      if (typeof response.publicKeyAlgorithm === "number") out.publicKeyAlgorithm = response.publicKeyAlgorithm;
    }
    return {
      id: data.id,
      rawId: data.id,
      type: "public-key",
      authenticatorAttachment: "cross-platform",
      clientExtensionResults: {},
      response: out,
    };
  };
  let built;
  if (response.kind === "assertion") {
    built = create(assertionProto);
    value(built, "clientDataJSON", decode(data.clientDataJSON));
    value(built, "authenticatorData", decode(response.authenticatorData));
    value(built, "signature", decode(response.signature));
    value(built, "userHandle", response.userHandle ? decode(response.userHandle) : null);
  } else {
    built = create(attestationProto);
    value(built, "clientDataJSON", decode(data.clientDataJSON));
    value(built, "attestationObject", decode(response.attestationObject));
    const transports = response.transports.slice();
    method(built, "getTransports", () => transports.slice());
    method(built, "getAuthenticatorData", () => response.authenticatorData ? decode(response.authenticatorData) : decode(""));
    method(built, "getPublicKey", () => response.publicKey ? decode(response.publicKey) : null);
    method(built, "getPublicKeyAlgorithm", () => typeof response.publicKeyAlgorithm === "number" ? response.publicKeyAlgorithm : null);
  }
  const credential = create(PKC.prototype);
  value(credential, "id", data.id);
  value(credential, "rawId", decode(data.id));
  value(credential, "type", "public-key");
  value(credential, "authenticatorAttachment", "cross-platform");
  value(credential, "response", built);
  method(credential, "getClientExtensionResults", () => ({}));
  method(credential, "toJSON", json);
  return credential;
};

const relay = (kind, options, nativeFn, self, args) => {
  let encoded;
  try {
    encoded = toJSONValue(options.publicKey, 0);
  } catch (error) {
    return reject(error);
  }
  const signal = options.signal;
  if (signal && signal.aborted) return reject(abortError(signal));
  const requestId = ++nextId;
  return new PromiseCtor((resolve, rejectPage) => {
    const entry = { resolve, reject: rejectPage, nativeFn, self, args, signal, onAbort: null };
    pending[requestId] = entry;
    if (signal && typeof signal.addEventListener === "function") {
      entry.onAbort = () => {
        if (pending[requestId] !== entry) return;
        delete pending[requestId];
        try { send({ action: "cancel", requestId }); } catch (_) { /* already gone */ }
        rejectPage(abortError(signal));
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
    }
    try {
      send({ action: "request", kind, options: encoded, requestId });
    } catch (_) {
      delete pending[requestId];
      rejectPage(notAllowed("The security key relay is unavailable."));
    }
  });
};

define(window, ${JSON.stringify(WEBAUTHN_SETTLE)}, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: (token, requestId, json) => {
    if (token !== capability) return false;
    const entry = pending[requestId];
    if (!entry) return false;
    delete pending[requestId];
    if (entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    let message;
    try {
      message = parse(json);
    } catch (_) {
      entry.reject(notAllowed("The security key relay returned an unreadable reply."));
      return true;
    }
    if (message.fallback === true) {
      try { entry.resolve(apply(entry.nativeFn, entry.self, entry.args)); } catch (error) { entry.reject(error); }
      return true;
    }
    if (message.ok !== true) {
      const error = message.error || {};
      entry.reject(pageError(error.name || "NotAllowedError", error.message || "The operation either timed out or was not allowed."));
      return true;
    }
    try {
      entry.resolve(buildCredential(message.credential));
    } catch (_) {
      entry.reject(notAllowed("The security key returned an unreadable credential."));
    }
    return true;
  },
});

const relayed = (options) => options !== null && typeof options === "object" && options.publicKey !== null && typeof options.publicKey === "object";
method(containerProto, "get", { get(...args) {
  const options = args[0];
  if (this !== container || !relayed(options) || options.mediation === "conditional") return apply(nativeGet, this, args);
  return relay("get", options, nativeGet, this, args);
} }.get);
method(containerProto, "create", { create(...args) {
  const options = args[0];
  if (this !== container || !relayed(options)) return apply(nativeCreate, this, args);
  return relay("create", options, nativeCreate, this, args);
} }.create);
})();`;
}

/** Expression that settles one page ceremony with `message` (JSON). */
export function webAuthnSettleExpression(
	capability: string,
	requestId: number,
	message: unknown
): string {
	const settle = `window[${JSON.stringify(WEBAUTHN_SETTLE)}]`;
	return `typeof ${settle} === "function" && ${settle}(${JSON.stringify(capability)}, ${requestId}, ${JSON.stringify(JSON.stringify(message))})`;
}
