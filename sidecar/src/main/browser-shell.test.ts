import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	installElectronFake,
	resetElectronFake,
} from "./__tests__/electron-fake.ts";

installElectronFake();
const { runtimeFixture } = await import("./__tests__/runtime-fixture.ts");
const {
	emitState,
	getBrowserState,
	normalizedNavigationUrl,
	setThemeTokens,
	sidecarState,
	updateSetting,
} = await import("./browser-shell.ts");

describe("browser shell state", () => {
	beforeEach(() => resetElectronFake());
	afterEach(() => {
		sidecarState.runtime = null;
	});

	it("refuses to report state before the runtime exists", () => {
		expect(() => getBrowserState()).toThrow("not ready");
	});

	it("reports tabs and a pending CDP restart from the runtime", () => {
		const { runtime, stripView } = runtimeFixture();
		sidecarState.runtime = runtime;
		sidecarState.remoteCdpEnabled = false;
		const tab = runtime.tabs.open("https://example.com/");
		runtime.store.setSetting("developerCdp", true);
		const state = getBrowserState();
		expect(state.activeId).toBe(tab.id);
		expect(state.cdpRestartRequired).toBe(true);
		emitState();
		setThemeTokens({ "--accent": "red" });
		const channels = stripView.webContents.sent.map(([channel]) => channel);
		expect(channels).toContain("ryu-browser:state");
		expect(stripView.webContents.sent.at(-1)).toEqual([
			"ryu-browser:theme",
			{ "--accent": "red" },
		]);
	});

	it("validates settings by key before storing them", () => {
		const { runtime } = runtimeFixture();
		sidecarState.runtime = runtime;
		updateSetting("approval", "always-ask");
		expect(runtime.store.getSettings().approval).toBe("always-ask");
		expect(() => updateSetting("approval", "sometimes")).toThrow(
			"Invalid permission policy"
		);
		expect(() => updateSetting("downloadDirectory", "/tmp")).toThrow(
			"dedicated control"
		);
	});

	it("rejects empty input and keeps IP-literal URLs", async () => {
		await expect(normalizedNavigationUrl("  ")).rejects.toThrow("Enter a URL");
		expect(await normalizedNavigationUrl("93.184.215.14/path")).toBe(
			"https://93.184.215.14/path"
		);
	});
});
