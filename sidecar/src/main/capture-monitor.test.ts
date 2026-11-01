import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import { z } from "zod";
import {
	BrowserActivityStore,
	BrowserCaptureMonitor,
	parseBrowserActivityMessage,
} from "./activity.ts";
import { createBrowserActivityInitScript } from "./capture-monitor-script.ts";
import type { BrowserCapturePayload } from "./capture-records.ts";

const capability = "private-host-capability";
const tab = {
	selectable: true,
	tabId: "capture",
	tabTitle: "Capture",
	tabUrl: "https://capture.test",
};

function fixture(monitor: BrowserCaptureMonitor, contextId = 1) {
	monitor.handleMessage("Runtime.executionContextCreated", {
		context: { id: contextId, auxData: { isDefault: true } },
	});
	const messages: string[] = [];
	class PagePromise<T> extends Promise<T> {}
	const context = createContext({
		Promise: PagePromise,
		__ryuBrowserActivity(value: BrowserCapturePayload) {
			const parsed = z.string().safeParse(value);
			if (!parsed.success) {
				return;
			}
			const payload = parsed.data;
			messages.push(payload);
			monitor.handleMessage("Runtime.bindingCalled", {
				name: "__ryuBrowserActivity",
				executionContextId: contextId,
				payload,
			});
		},
	});
	new Script(`
globalThis.window = globalThis;
class Event { constructor(type) { this.type = type; } }
class EventTarget {
  #listeners = [];
  addEventListener(type, handler) { this.#listeners[this.#listeners.length] = { type, handler }; }
  dispatchEvent(event) { for (const entry of this.#listeners) if (entry.type === event.type) entry.handler(event); }
}
class MediaStreamTrack extends EventTarget {
  #state = "live";
  #kind;
  #device;
  constructor(kind, device = true) { super(); this.#kind = kind; this.#device = device; }
  get readyState() { return this.#state; }
  get kind() { return this.#kind; }
  getSettings() { return this.#device ? { deviceId: "native-device" } : {}; }
  stop() { this.#state = "ended"; }
  clone() { return new MediaStreamTrack(this.#kind); }
}
class MediaStream {
  #tracks;
  constructor(tracks) { this.#tracks = tracks; }
  getTracks() { return this.#tracks; }
  clone() { return new MediaStream(this.#tracks.map(track => new MediaStreamTrack(track.kind, Boolean(track.getSettings().deviceId)))); }
}
globalThis.MediaStreamTrack = MediaStreamTrack;
globalThis.MediaStream = MediaStream;
globalThis.Event = Event;
globalThis.EventTarget = EventTarget;
globalThis.device = new MediaStreamTrack("video");
const nativeResolve = Promise.resolve.bind(Promise);
const Stream = MediaStream;
class MediaDevices {
  getUserMedia(constraints) { if (constraints) void constraints.video; return nativeResolve(new Stream([device])); }
  getDisplayMedia() { return nativeResolve(new Stream([device])); }
}
class Navigator {
  mediaDevices = new MediaDevices();
  webkitGetUserMedia(_constraints, success) { success(new Stream([device])); }
}
globalThis.MediaDevices = MediaDevices;
globalThis.Navigator = Navigator;
globalThis.navigator = new Navigator();
globalThis.timer = undefined;
globalThis.setInterval = (callback) => { timer = callback; return 1; };
`).runInContext(context);
	new Script(createBrowserActivityInitScript(capability)).runInContext(context);
	return {
		messages,
		run(source: string): void {
			new Script(source).runInContext(context);
		},
		async runAsync(source: string): Promise<void> {
			await new Script(source).runInContext(context);
		},
		read(source: string): string | number | boolean | undefined {
			return z
				.union([z.string(), z.number(), z.boolean(), z.undefined()])
				.parse(new Script(source).runInContext(context));
		},
	};
}

function stateFixture() {
	const store = new BrowserActivityStore();
	const monitor = new BrowserCaptureMonitor(capability, (kind, active) =>
		store.setTabActivity({ ...tab, kind }, active, 1000)
	);
	return { store, monitor };
}

describe("trusted capture lifecycle", () => {
	it("retains native capture when requested navigation does not replace the document", async () => {
		const { store, monitor } = stateFixture();
		const page = fixture(monitor);
		await page.runAsync("navigator.mediaDevices.getUserMedia({video:true})");
		const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		const method = source.match(
			/\tnavigate\(id: string, url: string\): TabInfo \| null \{([\s\S]*?)\n\t\}/
		)?.[1];
		if (!method) {
			throw new Error("Production navigation method was not found");
		}
		const tabState = {
			captureReady: Promise.resolve(),
			id: "capture",
			loading: false,
			view: {
				webContents: {
					loadURL: () => Promise.reject(new Error("ERR_ABORTED")),
				},
			},
		};
		const context = createContext({
			manager: {
				activities: store,
				find: () => tabState,
				info: () => ({ id: "capture" }),
				layout() {},
				onChange() {},
			},
		});
		new Script(
			`(function(id, url) {${method}}).call(manager, "capture", "https://capture.test/#fragment")`
		).runInContext(context);
		await Promise.resolve();
		await Promise.resolve();
		expect(store.snapshot(20_000)).toMatchObject([
			{ kind: "camera", status: "active" },
		]);
		page.run("device.stop()");
		expect(store.snapshot(1001)[0]?.status).toBe("recent");
	});

	it("observes borrowed prototype capture methods and legacy callbacks", async () => {
		const { store, monitor } = stateFixture();
		const page = fixture(monitor);
		await page.runAsync(
			"Reflect.apply(MediaDevices.prototype.getUserMedia, navigator.mediaDevices, [{video:true}])"
		);
		expect(store.snapshot(20_000)[0]?.status).toBe("active");
		page.run("device.stop(); device = new MediaStreamTrack('video')");
		await page.runAsync(
			"Reflect.apply(MediaDevices.prototype.getDisplayMedia, navigator.mediaDevices, [{}])"
		);
		expect(
			store
				.snapshot(20_000)
				.some((entry) => entry.kind === "screen" && entry.status === "active")
		).toBe(true);
		page.run(
			"device.stop(); device = new MediaStreamTrack('video'); Reflect.apply(Navigator.prototype.webkitGetUserMedia, navigator, [{video:true}, () => {}])"
		);
		expect(
			store
				.snapshot(20_000)
				.some((entry) => entry.kind === "camera" && entry.status === "active")
		).toBe(true);
	});

	it("rejects format-only page stop messages while a live track persists past recent expiry", async () => {
		const { store, monitor } = stateFixture();
		const page = fixture(monitor);
		await page.runAsync("navigator.mediaDevices.getUserMedia({video:true})");
		page.run(
			`__ryuBrowserActivity(JSON.stringify({action:"stop",kind:"camera"})); __ryuBrowserActivity(JSON.stringify({capability:"guess",trackId:1,action:"stop",kind:"camera"}));`
		);
		expect(store.snapshot(20_000)).toMatchObject([
			{ kind: "camera", status: "active" },
		]);
	});

	it("ignores synthetic ended and shadowed JS state but recognizes actual native stop", async () => {
		const { store, monitor } = stateFixture();
		const page = fixture(monitor);
		await page.runAsync("navigator.mediaDevices.getUserMedia({video:true})");
		page.run(
			`Object.defineProperty(device,"readyState",{value:"ended"}); device.dispatchEvent(new Event("ended")); timer();`
		);
		expect(store.snapshot(20_000)[0]?.status).toBe("active");
		page.run("device.stop()");
		expect(store.snapshot(1001)[0]?.status).toBe("recent");
		expect(store.snapshot(16_001)).toEqual([]);
	});

	it("retains the indicator until every cloned capture track really stops", async () => {
		const { store, monitor } = stateFixture();
		const page = fixture(monitor);
		await page.runAsync("navigator.mediaDevices.getUserMedia({video:true})");
		page.run("globalThis.copied = device.clone(); device.stop();");
		expect(store.snapshot(20_000)[0]?.status).toBe("active");
		page.run("copied.stop()");
		expect(store.snapshot(1001)[0]?.status).toBe("recent");
	});

	it("observes native stream clones that bypass the JavaScript track clone method", async () => {
		const { store, monitor } = stateFixture();
		const page = fixture(monitor);
		await page.runAsync("navigator.mediaDevices.getUserMedia({video:true})");
		page.run(
			"globalThis.streamCopy = new MediaStream([device]).clone(); device.stop();"
		);
		expect(store.snapshot(20_000)[0]?.status).toBe("active");
		page.run("streamCopy.getTracks()[0].stop()");
		expect(store.snapshot(1001)[0]?.status).toBe("recent");
	});

	it("does not treat generated tracks in a mixed stream clone as camera capture", async () => {
		const { store, monitor } = stateFixture();
		const page = fixture(monitor);
		await page.runAsync("navigator.mediaDevices.getUserMedia({video:true})");
		page.run(
			"globalThis.streamCopy = new MediaStream([device, new MediaStreamTrack('video', false)]).clone(); device.stop();"
		);
		expect(store.snapshot(20_000)[0]?.status).toBe("active");
		page.run("streamCopy.getTracks()[0].stop()");
		expect(store.snapshot(1001)[0]?.status).toBe("recent");
		expect(page.read("streamCopy.getTracks()[1].readyState")).toBe("live");
	});

	it("accepts clone sources acquired in another frame but rejects unacquired sources", async () => {
		const { store, monitor } = stateFixture();
		const child = fixture(monitor, 1);
		const parent = fixture(monitor, 2);
		parent.run("new MediaStream([device]).clone()");
		expect(store.snapshot(20_000)).toEqual([]);
		await child.runAsync("navigator.mediaDevices.getUserMedia({video:true})");
		parent.run(
			"globalThis.copied = new MediaStream([device]).clone().getTracks()[0]"
		);
		child.run("device.stop()");
		expect(store.snapshot(20_000)[0]?.status).toBe("active");
		parent.run("copied.stop()");
		expect(store.snapshot(1001)[0]?.status).toBe("recent");
	});

	it("captures builtins before page poisoning and binding replacement without exposing the capability", async () => {
		const { store, monitor } = stateFixture();
		const page = fixture(monitor);
		expect(
			page.read(
				"navigator.mediaDevices.getUserMedia.toString().includes('private-host-capability')"
			)
		).toBe(false);
		page.run(`
globalThis.stolen = [];
__ryuBrowserActivity = (payload) => stolen.push(payload);
JSON.stringify = (payload) => { stolen.push(payload); throw Error("poisoned JSON"); };
Object.prototype.toJSON = function() { stolen.push(this); throw Error("poisoned toJSON"); };
Reflect.apply = () => { throw Error("poisoned apply"); };
Function.prototype.call = Function.prototype.apply = Function.prototype.bind = () => { throw Error("poisoned function"); };
MediaStream.prototype.getTracks = () => [];
MediaStreamTrack.prototype.getSettings = () => ({ displaySurface: "window" });
EventTarget.prototype.addEventListener = () => { throw Error("poisoned event"); };
setInterval = () => { throw Error("poisoned timer"); };
Object.defineProperty(Promise.prototype,"constructor",{get() { stolen.push(this); throw Error("poisoned constructor"); }});
void navigator.mediaDevices.getUserMedia({video:true});
`);
		await Promise.resolve();
		await Promise.resolve();
		expect(store.snapshot(20_000)[0]?.status).toBe("active");
		expect(page.read("stolen.length")).toBe(0);
		page.run("device.stop()");
		expect(store.snapshot(1001)[0]?.status).toBe("recent");
	});

	it("supports legacy capture callbacks", () => {
		const { store, monitor } = stateFixture();
		const page = fixture(monitor);
		page.run("navigator.webkitGetUserMedia({video:true}, () => {})");
		expect(store.snapshot(20_000)[0]?.status).toBe("active");
	});

	it("keeps caller and stack introspection behind strict observer frames", async () => {
		const { store, monitor } = stateFixture();
		const page = fixture(monitor);
		page.run(`
globalThis.recovered = [];
function inspectCallers() {
  try {
    let caller = inspectCallers.caller;
    for (let index = 0; caller && index < 12; index++) {
      recovered.push(caller.toString());
      caller = caller.caller;
    }
  } catch {}
  try {
    Error.prepareStackTrace = (_error, sites) => {
      for (const site of sites) {
        const fn = site.getFunction?.();
        if (fn) recovered.push(fn.toString());
      }
      return "inspected";
    };
    void new Error().stack;
  } catch {}
}
void navigator.mediaDevices.getUserMedia({ get video() { inspectCallers(); return true; } });
navigator.webkitGetUserMedia({video:true}, inspectCallers);
`);
		await Promise.resolve();
		expect(page.read("recovered.join('\\n')")).not.toContain(capability);
		expect(store.snapshot(20_000)[0]?.status).toBe("active");
		expect(createBrowserActivityInitScript(capability)).toContain(
			'"use strict";'
		);
	});

	it("aggregates frames and rejects stale navigation/context messages", async () => {
		const { store, monitor } = stateFixture();
		const first = fixture(monitor, 1);
		const second = fixture(monitor, 2);
		await first.run("navigator.mediaDevices.getUserMedia({video:true})");
		await second.run("navigator.mediaDevices.getUserMedia({video:true})");
		first.run("device.stop()");
		expect(store.snapshot(20_000)[0]?.status).toBe("active");
		monitor.handleMessage("Runtime.executionContextDestroyed", {
			executionContextId: 1,
		});
		monitor.handleMessage("Runtime.bindingCalled", {
			name: "__ryuBrowserActivity",
			executionContextId: 1,
			payload: second.messages[0],
		});
		expect(store.snapshot(20_000)[0]?.status).toBe("active");
		second.run("device.stop()");
		expect(store.snapshot(1001)[0]?.status).toBe("recent");
	});

	it("rejects malformed capabilities, audio playback messages and invalid track IDs", () => {
		for (const payload of [
			{ action: "stop", kind: "camera" },
			{ capability, action: "stop", kind: "audio", trackId: 1 },
			{ capability, action: "stop", kind: "camera", trackId: -1 },
			{ capability, action: "stop", kind: "camera", trackId: 1.5 },
		]) {
			expect(parseBrowserActivityMessage(JSON.stringify(payload))).toBeNull();
		}
	});
});
