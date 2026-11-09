import { beforeEach, describe, expect, it } from "bun:test";
import type { BaseWindow, Session } from "electron";
import {
	FakeBaseWindow,
	FakeSession,
	type FakeWebContentsView,
	installElectronFake,
	resetElectronFake,
} from "./__tests__/electron-fake.ts";

installElectronFake();
const { ElectronTabManager } = await import("./electron-tab-manager.ts");
const { TabCore } = await import("./tab-core.ts");
const { TabPageOps } = await import("./tab-page-ops.ts");
const { TabInspection } = await import("./tab-inspection.ts");
const { TabInput } = await import("./tab-input.ts");
const { RefError } = await import("./tab-manager.ts");

function managerFixture() {
	const win = new FakeBaseWindow();
	let changes = 0;
	const manager = new ElectronTabManager(
		new FakeSession("test") as unknown as Session,
		win as unknown as BaseWindow,
		() => {
			changes += 1;
		},
		() => undefined,
		() => undefined
	);
	return { changes: () => changes, manager, win };
}

function viewOf(manager: object, index: number): FakeWebContentsView {
	const views = Reflect.get(manager, "tabs") as { view: FakeWebContentsView }[];
	const view = views[index]?.view;
	if (!view) {
		throw new Error(`no tab at ${index}`);
	}
	return view;
}

describe("ElectronTabManager layers", () => {
	beforeEach(() => resetElectronFake());

	it("stacks every layer under the public tab manager", () => {
		const { manager } = managerFixture();
		for (const layer of [TabCore, TabPageOps, TabInspection, TabInput]) {
			expect(manager).toBeInstanceOf(layer);
		}
	});

	it("opens, lists, and closes a tab, releasing its debugger", async () => {
		const { changes, manager } = managerFixture();
		const opened = manager.open("https://example.com/");
		expect(manager.list().map((tab) => tab.id)).toEqual([opened.id]);
		expect(manager.activeId()).toBe(opened.id);
		const contents = viewOf(manager, 0).webContents;
		await Promise.resolve();
		await Promise.resolve();
		expect(manager.close(opened.id)).toBe(true);
		expect(contents.closed).toBe(true);
		expect(contents.debugger.isAttached()).toBe(false);
		expect(manager.list()).toEqual([]);
		expect(manager.activeId()).toBeNull();
		expect(changes()).toBeGreaterThan(1);
		expect(manager.close(opened.id)).toBe(false);
	});

	it("answers null for a tab that does not exist on every layer", async () => {
		const { manager } = managerFixture();
		expect(manager.navigate("missing", "https://example.com/")).toBeNull();
		expect(manager.title("missing")).toBeNull();
		expect(await manager.screenshot("missing")).toBeNull();
		expect(manager.clearAnnotations("missing")).toBeNull();
		expect(await manager.click("missing", "@e1")).toBeNull();
		expect(await manager.readTotpSetup("missing", "@e1")).toBeNull();
	});

	it("captures the focused tab and refuses refs without a snapshot", async () => {
		const { manager } = managerFixture();
		const tab = manager.open("https://example.com/");
		expect(await manager.screenshot(tab.id)).toBe(
			Buffer.from("png").toString("base64")
		);
		expect(manager.clearAnnotations(tab.id)).toBe(true);
		await expect(manager.click(tab.id, "@e1")).rejects.toBeInstanceOf(RefError);
	});

	it("closes a new tab whose contents fail preparation before it loads", () => {
		const session = new FakeSession("bot") as unknown as Session;
		const win = new FakeBaseWindow();
		const manager = new ElectronTabManager(
			session,
			win as unknown as BaseWindow,
			() => undefined,
			() => undefined,
			() => undefined,
			undefined,
			"bot",
			() => {
				throw new Error("WebRTC policy did not stick");
			}
		);
		expect(() => manager.open("https://example.com/")).toThrow(
			"WebRTC policy did not stick"
		);
		expect(manager.list()).toEqual([]);
		expect(win.children).toEqual([]);
	});
});
