import { beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Session, WebContents } from "electron";
import {
	electronFakeState,
	FakeSession,
	FakeWebContents,
	installElectronFake,
	resetElectronFake,
} from "./__tests__/electron-fake.ts";

installElectronFake();
const { installPermissionHandlers, permissionKeys, permissionOrigin } =
	await import("./browser-handlers.ts");
const { BrowserStateStore } = await import("./browser-state-store.ts");

type RequestHandler = (
	contents: WebContents,
	permission: string,
	callback: (granted: boolean) => void,
	details: { requestingUrl?: string; mediaTypes?: string[] }
) => Promise<void>;

describe("browser permission handlers", () => {
	beforeEach(() => resetElectronFake());

	it("maps native permissions to stored permission keys", () => {
		expect(permissionKeys("media", { mediaTypes: ["audio"] } as never)).toEqual(
			["microphone"]
		);
		expect(permissionKeys("media", {} as never)).toEqual([
			"camera",
			"microphone",
		]);
		expect(permissionKeys("midi", {} as never)).toEqual([]);
	});

	it("derives a web origin from the request, else the page URL", () => {
		const contents = new FakeWebContents();
		contents.url = "https://page.example/x";
		const asContents = contents as unknown as WebContents;
		expect(
			permissionOrigin(asContents, {
				requestingUrl: "https://frame.example/y",
			} as never)
		).toBe("https://frame.example");
		expect(permissionOrigin(asContents, {} as never)).toBe(
			"https://page.example"
		);
		contents.url = "file:///etc/passwd";
		expect(permissionOrigin(asContents, {} as never)).toBeNull();
	});

	it("never prompts in a non-interactive profile and honors saved decisions", async () => {
		const browserSession = new FakeSession("bot");
		const dir = electronFakeState.userData;
		const store = new BrowserStateStore(dir, join(dir, "downloads"));
		store.setSitePermission({
			decision: "allow",
			origin: "https://ok.example",
			permission: "geolocation",
		});
		installPermissionHandlers(
			browserSession as unknown as Session,
			store,
			null,
			false
		);
		const handler = browserSession.permissionRequest as RequestHandler;
		const contents = new FakeWebContents() as unknown as WebContents;
		const decide = (url: string, permission: string) =>
			new Promise<boolean>((resolve) => {
				void handler(contents, permission, resolve, { requestingUrl: url });
			});
		expect(await decide("https://ok.example/", "geolocation")).toBe(true);
		expect(await decide("https://other.example/", "geolocation")).toBe(false);
	});
});
