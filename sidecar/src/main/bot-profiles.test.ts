import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botSessionPartition } from "./bot-partition.ts";
import {
	botProfileExport,
	botProfileIds,
	cookieMetadata,
	directoryBytes,
	isBotProfileId,
	MAX_EXPORTED_COOKIES,
	profileIdFor,
	readBotProfileState,
} from "./bot-profiles.ts";

function managedRoot(): string {
	return mkdtempSync(join(tmpdir(), "ryu-bot-profiles-"));
}

describe("bot profile ids", () => {
	it("accepts only the folder names partitions map to", () => {
		const id = profileIdFor("agent-a");
		expect(`persist:${id}`).toBe(botSessionPartition("agent-a"));
		expect(isBotProfileId(id)).toBe(true);
		expect(isBotProfileId("ryu-bot-../x")).toBe(false);
		expect(isBotProfileId("ryu-bot-A")).toBe(false);
		expect(isBotProfileId("other-folder")).toBe(false);
		expect(isBotProfileId(`ryu-bot-${"a".repeat(81)}`)).toBe(false);
	});

	it("lists profile folders and skips files and foreign names", () => {
		const root = managedRoot();
		const agents = join(root, "agents");
		mkdirSync(join(agents, profileIdFor("b")), { recursive: true });
		mkdirSync(join(agents, profileIdFor("a")), { recursive: true });
		mkdirSync(join(agents, "not-a-profile"), { recursive: true });
		writeFileSync(join(agents, "ryu-bot-file"), "x");
		expect(botProfileIds(root)).toEqual(
			[profileIdFor("a"), profileIdFor("b")].sort()
		);
		expect(botProfileIds(join(root, "missing"))).toEqual([]);
	});
});

describe("directoryBytes", () => {
	it("sums files without following symlinks", () => {
		const root = managedRoot();
		mkdirSync(join(root, "nested"));
		writeFileSync(join(root, "a"), "12345");
		writeFileSync(join(root, "nested", "b"), "123");
		const outside = managedRoot();
		writeFileSync(join(outside, "big"), "x".repeat(1000));
		symlinkSync(outside, join(root, "link"));
		expect(directoryBytes(root)).toBe(8);
		expect(directoryBytes(join(root, "missing"))).toBe(0);
	});
});

describe("profile state and export", () => {
	it("reads history, permissions and downloads, and survives a damaged file", () => {
		const folder = managedRoot();
		writeFileSync(
			join(folder, "browser-state.json"),
			JSON.stringify({
				downloads: [],
				history: [
					{ id: "h1", title: "Home", url: "https://a.example/", visitedAt: 5 },
				],
				settings: {
					sitePermissions: [
						{
							decision: "allow",
							origin: "https://a.example",
							permission: "notifications",
						},
					],
				},
			})
		);
		const state = readBotProfileState(folder);
		expect(state.history).toEqual([
			{ title: "Home", url: "https://a.example/", visitedAt: 5 },
		]);
		expect(state.sitePermissions).toEqual([
			{
				decision: "allow",
				origin: "https://a.example",
				permission: "notifications",
			},
		]);
		writeFileSync(join(folder, "browser-state.json"), "{not json");
		expect(readBotProfileState(folder).history).toEqual([]);
	});

	it("never exports a cookie value", () => {
		const cookies = [
			{
				domain: ".a.example",
				expirationDate: 99,
				httpOnly: true,
				name: "session",
				path: "/",
				secure: true,
				value: "SECRET-SESSION-VALUE",
			},
		];
		expect(cookieMetadata(cookies)).toEqual([
			{
				domain: ".a.example",
				expires: 99,
				http_only: true,
				name: "session",
				path: "/",
				secure: true,
			},
		]);
		const exported = botProfileExport(
			"ryu-bot-a-0123456789abcdef",
			{ downloads: [], history: [], sitePermissions: [] },
			cookies,
			new Date(0)
		);
		expect(JSON.stringify(exported)).not.toContain("SECRET-SESSION-VALUE");
		expect(exported.format).toBe("ryu-browser-profile/1");
		expect(exported.cookies_truncated).toBe(false);
	});

	it("caps the exported cookie list and says so", () => {
		const many = Array.from({ length: MAX_EXPORTED_COOKIES + 1 }, (_, i) => ({
			name: `c${i}`,
		}));
		const exported = botProfileExport(
			"ryu-bot-a-0123456789abcdef",
			{ downloads: [], history: [], sitePermissions: [] },
			many,
			new Date(0)
		);
		expect(exported.cookies).toHaveLength(MAX_EXPORTED_COOKIES);
		expect(exported.cookies_truncated).toBe(true);
	});
});
