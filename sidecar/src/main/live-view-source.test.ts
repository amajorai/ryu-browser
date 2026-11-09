import { describe, expect, it } from "bun:test";
import type { WebContents } from "electron";
import { FakeWebContents } from "./__tests__/electron-fake.ts";
import {
	LIVE_VIEW_CAPTURE_QUALITY,
	liveViewSourceFor,
} from "./live-view-source.ts";

function source(contents: FakeWebContents) {
	return liveViewSourceFor(contents as unknown as WebContents);
}

describe("liveViewSourceFor", () => {
	it("attaches the in-process debugger once and sends commands on it", async () => {
		const contents = new FakeWebContents();
		const view = source(contents);
		await view.send("Page.startScreencast", { format: "jpeg" });
		await view.send("Page.stopScreencast");
		expect(contents.debugger.isAttached()).toBe(true);
		expect(contents.debugger.commands).toEqual([
			"Page.startScreencast",
			"Page.stopScreencast",
		]);
	});

	it("relays debugger events until unsubscribed", () => {
		const contents = new FakeWebContents();
		const seen: string[] = [];
		const stop = source(contents).onMessage((method) => seen.push(method));
		contents.debugger.emit("message", {}, "Page.screencastFrame", {});
		stop();
		contents.debugger.emit("message", {}, "Page.screencastFrame", {});
		expect(seen).toEqual(["Page.screencastFrame"]);
	});

	it("captures a JPEG while keeping a hidden window hidden", async () => {
		const contents = new FakeWebContents();
		const image = await source(contents).capture();
		expect(image).toEqual({
			height: 600,
			image: Buffer.from(`jpeg@${LIVE_VIEW_CAPTURE_QUALITY}`).toString(
				"base64"
			),
			width: 800,
		});
		expect(contents.captureOptions).toEqual([{ stayHidden: true }]);
	});

	it("returns no image for an empty capture or a closed tab", async () => {
		const contents = new FakeWebContents();
		contents.captureSize = { height: 0, width: 0 };
		expect(await source(contents).capture()).toBeNull();
		contents.close();
		expect(await source(contents).capture()).toBeNull();
		await expect(source(contents).send("Page.enable")).rejects.toThrow(
			"the tab is closed"
		);
	});
});
