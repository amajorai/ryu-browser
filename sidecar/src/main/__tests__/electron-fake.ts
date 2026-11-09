// In-memory stand-in for the slice of Electron the main-process modules touch.
// Bun cannot load the real `electron` package outside an Electron binary, so
// tests install this one shared fake with `installElectronFake()` and import
// the module under test afterwards. Every test file shares the same instance:
// call `resetElectronFake()` in `beforeEach` to start from a clean slate.

import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Listener = (...args: unknown[]) => void;

class Emitter {
	readonly listeners = new Map<string, Listener[]>();
	on(event: string, listener: Listener): this {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}
	removeListener(event: string, listener: Listener): this {
		this.listeners.set(
			event,
			(this.listeners.get(event) ?? []).filter((item) => item !== listener)
		);
		return this;
	}
	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(...args);
		}
	}
}

export class FakeDebugger extends Emitter {
	attached = false;
	readonly commands: string[] = [];
	attach(): void {
		this.attached = true;
	}
	detach(): void {
		this.attached = false;
	}
	isAttached(): boolean {
		return this.attached;
	}
	sendCommand(method: string): Promise<Record<string, never>> {
		this.commands.push(method);
		return Promise.resolve({});
	}
}

export class FakeWebContents extends Emitter {
	closed = false;
	readonly debugger = new FakeDebugger();
	readonly loaded: string[] = [];
	readonly sent: [string, unknown][] = [];
	title = "";
	url = "about:blank";
	webRtcPolicy = "default";
	/** Set to make `setWebRTCIPHandlingPolicy` silently not take effect. */
	ignoreWebRtcPolicy = false;
	canGoBack(): boolean {
		return false;
	}
	canGoForward(): boolean {
		return false;
	}
	getZoomFactor(): number {
		return 1;
	}
	/** Size of the next `capturePage` image; zero makes it an empty capture. */
	captureSize = { height: 600, width: 800 };
	readonly captureOptions: unknown[] = [];
	capturePage(
		_rect?: unknown,
		options?: unknown
	): Promise<{
		getSize: () => { height: number; width: number };
		toJPEG: (quality: number) => Buffer;
		toPNG: () => Buffer;
	}> {
		this.captureOptions.push(options);
		const size = this.captureSize;
		return Promise.resolve({
			getSize: () => size,
			toJPEG: (quality: number) => Buffer.from(`jpeg@${quality}`),
			toPNG: () => Buffer.from("png"),
		});
	}
	close(): void {
		this.closed = true;
	}
	getTitle(): string {
		return this.title;
	}
	getURL(): string {
		return this.url;
	}
	isDestroyed(): boolean {
		return this.closed;
	}
	getWebRTCIPHandlingPolicy(): string {
		return this.webRtcPolicy;
	}
	loadURL(url: string): Promise<void> {
		this.loaded.push(url);
		this.url = url;
		return Promise.resolve();
	}
	loadFile(): Promise<void> {
		return Promise.resolve();
	}
	send(channel: string, payload: unknown): void {
		this.sent.push([channel, payload]);
	}
	setWebRTCIPHandlingPolicy(policy: string): void {
		if (!this.ignoreWebRtcPolicy) {
			this.webRtcPolicy = policy;
		}
	}
	setWindowOpenHandler(): void {
		// Popups are denied by the tab manager; nothing to record.
	}
}

export class FakeWebContentsView {
	bounds = { height: 0, width: 0, x: 0, y: 0 };
	readonly webContents = new FakeWebContents();
	readonly options: unknown;
	constructor(options?: unknown) {
		this.options = options;
	}
	setBounds(bounds: { height: number; width: number; x: number; y: number }) {
		this.bounds = bounds;
	}
}

export class FakeBaseWindow extends Emitter {
	destroyed = false;
	readonly children: FakeWebContentsView[] = [];
	readonly contentView = {
		addChildView: (view: FakeWebContentsView) => {
			this.children.push(view);
		},
		removeChildView: (view: FakeWebContentsView) => {
			const index = this.children.indexOf(view);
			if (index >= 0) {
				this.children.splice(index, 1);
			}
		},
	};
	readonly options: unknown;
	constructor(options?: unknown) {
		super();
		this.options = options;
	}
	destroy(): void {
		this.destroyed = true;
	}
	getContentSize(): [number, number] {
		return [1200, 800];
	}
}

type RequestListener = (
	details: { resourceType: string; url: string },
	callback: (response: { cancel: boolean }) => void
) => void;

export class FakeSession extends Emitter {
	cleared = false;
	downloadPath = "";
	proxyRules = "";
	/** When set, `resolveProxy` reports this instead of the configured proxy. */
	reportedProxy: string | null = null;
	requestListener: RequestListener | null = null;
	permissionCheck: unknown = null;
	permissionRequest: unknown = null;
	readonly partition: string;
	readonly webRequest = {
		onBeforeRequest: (_filter: unknown, listener: RequestListener) => {
			this.requestListener = listener;
		},
	};
	constructor(partition: string) {
		super();
		this.partition = partition;
	}
	/** Cookies `cookies.get` reports; cleared with the storage data. */
	cookieJar: { domain: string; name: string; value: string }[] = [];
	readonly cookies = {
		get: (_filter: unknown) => Promise.resolve([...this.cookieJar]),
	};
	clearCache(): Promise<void> {
		return Promise.resolve();
	}
	clearStorageData(): Promise<void> {
		this.cleared = true;
		this.cookieJar = [];
		return Promise.resolve();
	}
	forceReloadProxyConfig(): Promise<void> {
		return Promise.resolve();
	}
	resolveProxy(): Promise<string> {
		const port = this.proxyRules.split(":").at(-1) ?? "";
		return Promise.resolve(this.reportedProxy ?? `SOCKS5 127.0.0.1:${port}`);
	}
	setDownloadPath(path: string): void {
		this.downloadPath = path;
	}
	setPermissionCheckHandler(handler: unknown): void {
		this.permissionCheck = handler;
	}
	setPermissionRequestHandler(handler: unknown): void {
		this.permissionRequest = handler;
	}
	setProxy(config: { proxyRules: string }): Promise<void> {
		this.proxyRules = config.proxyRules;
		return Promise.resolve();
	}
}

interface FakeState {
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
	hostResolver: unknown;
	readonly partitions: Map<string, FakeSession>;
	switches: Map<string, string>;
	userData: string;
}

const state: FakeState = {
	handlers: new Map(),
	hostResolver: null,
	partitions: new Map(),
	switches: new Map(),
	userData: "",
};

const defaultSession = new FakeSession("default");

export const fakeElectron = {
	app: {
		commandLine: {
			appendSwitch: (name: string, value = "") =>
				state.switches.set(name, value),
			getSwitchValue: (name: string) => state.switches.get(name) ?? "",
			hasSwitch: (name: string) => state.switches.has(name),
		},
		configureHostResolver: (options: unknown) => {
			state.hostResolver = options;
		},
		getPath: () => state.userData,
	},
	BaseWindow: FakeBaseWindow,
	dialog: {},
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
			state.handlers.set(channel, handler);
		},
	},
	safeStorage: {},
	session: {
		defaultSession,
		fromPartition: (partition: string) => {
			const existing = state.partitions.get(partition);
			if (existing) {
				return existing;
			}
			const created = new FakeSession(partition);
			state.partitions.set(partition, created);
			return created;
		},
	},
	shell: {},
	WebContentsView: FakeWebContentsView,
};

export const electronFakeState = state;

/** Clear every recorded handler, partition, and switch; use a fresh data dir. */
export function resetElectronFake(): void {
	state.handlers.clear();
	state.partitions.clear();
	state.switches.clear();
	state.hostResolver = null;
	state.userData = mkdtempSync(join(tmpdir(), "ryu-browser-test-"));
}

let installed = false;

/** Route `import … from "electron"` to the fake for this test process. */
export function installElectronFake(): void {
	if (installed) {
		return;
	}
	installed = true;
	resetElectronFake();
	mock.module("electron", () => fakeElectron);
}
