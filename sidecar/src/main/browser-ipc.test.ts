import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	electronFakeState,
	installElectronFake,
	resetElectronFake,
} from "./__tests__/electron-fake.ts";

installElectronFake();
const { runtimeFixture } = await import("./__tests__/runtime-fixture.ts");
const { sidecarState } = await import("./browser-shell.ts");
const { registerIpcHandlers } = await import("./browser-ipc.ts");

function handler(channel: string): (...args: unknown[]) => unknown {
	const found = electronFakeState.handlers.get(channel);
	if (!found) {
		throw new Error(`no handler for ${channel}`);
	}
	return found;
}

describe("browser shell IPC", () => {
	beforeEach(() => resetElectronFake());
	afterEach(() => {
		sidecarState.runtime = null;
	});

	it("registers nothing before the runtime exists", () => {
		registerIpcHandlers();
		expect(electronFakeState.handlers.size).toBe(0);
	});

	it("stores only web-origin site permissions", () => {
		const { runtime } = runtimeFixture();
		sidecarState.runtime = runtime;
		registerIpcHandlers();
		const add = handler("ryu-browser:add-site-permission");
		add(null, {
			decision: "deny",
			origin: "https://example.com/path",
			permission: "camera",
		});
		expect(runtime.store.permissionFor("https://example.com", "camera")).toBe(
			"deny"
		);
		expect(() =>
			add(null, {
				decision: "allow",
				origin: "file:///tmp",
				permission: "camera",
			})
		).toThrow("http or https");
	});

	it("returns a copy of the theme tokens", () => {
		const { runtime } = runtimeFixture();
		runtime.themeTokens = { "--fg": "black" };
		sidecarState.runtime = runtime;
		registerIpcHandlers();
		const tokens = handler("ryu-browser:get-theme")();
		expect(tokens).toEqual({ "--fg": "black" });
		expect(tokens).not.toBe(runtime.themeTokens);
	});
});
