import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserStateStore } from "./browser-state-store.ts";

function profileDir(): string {
	return mkdtempSync(join(tmpdir(), "ryu-browser-store-"));
}

describe("BrowserStateStore", () => {
	it("persists settings, permissions, and history across reopen", () => {
		const dir = profileDir();
		const store = new BrowserStateStore(dir, join(dir, "downloads"));
		store.setSetting("allowControl", false);
		store.setSitePermission({
			decision: "allow",
			origin: "https://example.com",
			permission: "camera",
		});
		store.addHistory("https://example.com/a", "A");
		store.addHistory("https://example.com/a", "A again");
		store.addHistory("about:blank", "ignored");
		store.flush();

		const reopened = new BrowserStateStore(dir, join(dir, "downloads"));
		expect(reopened.getSettings().allowControl).toBe(false);
		expect(reopened.permissionFor("https://example.com", "camera")).toBe(
			"allow"
		);
		expect(reopened.permissionFor("https://example.com", "microphone")).toBe(
			null
		);
		expect(reopened.getHistory().map((entry) => entry.title)).toEqual([
			"A again",
		]);
	});

	it("restores defaults from a damaged profile file", () => {
		const dir = profileDir();
		const first = new BrowserStateStore(dir, "/downloads");
		first.addExtensionPath("/ext/one");
		const file = join(dir, "browser-state.json");
		expect(JSON.parse(readFileSync(file, "utf8")).extensionPaths).toEqual([
			"/ext/one",
		]);
		Bun.write(file, "{not json");
		const recovered = new BrowserStateStore(dir, "/downloads");
		expect(recovered.getExtensionPaths()).toEqual([]);
		expect(recovered.getSettings().downloadDirectory).toBe("/downloads");
	});
});
