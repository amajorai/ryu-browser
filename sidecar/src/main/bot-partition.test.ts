import { describe, expect, it } from "bun:test";
import { join, relative, sep } from "node:path";
import {
	BOT_PARTITION_PREFIX,
	BOT_PROFILES_DIRECTORY,
	botProfilePaths,
	botSessionPartition,
	LEGACY_SHARED_BOT_PARTITION,
	LEGACY_SHARED_BOT_STATE_FILE,
} from "./bot-partition.ts";

const PARTITION_NAME = /^persist:ryu-bot-[a-z0-9-]+$/;

describe("botSessionPartition", () => {
	it("gives two agents distinct partitions", () => {
		expect(botSessionPartition("agent-a")).not.toBe(
			botSessionPartition("agent-b")
		);
	});

	it("gives the same agent the same partition every time", () => {
		expect(botSessionPartition("agent-a")).toBe(botSessionPartition("agent-a"));
	});

	it("keeps ids that sanitize alike in separate partitions", () => {
		const partitions = new Set(
			["Agent-A", "agent-a", "agent_a", "agent.a", "agent a"].map(
				botSessionPartition
			)
		);
		expect(partitions.size).toBe(5);
		const longPrefix = "a".repeat(80);
		expect(botSessionPartition(`${longPrefix}1`)).not.toBe(
			botSessionPartition(`${longPrefix}2`)
		);
	});

	it("limits names to lowercase letters, digits, and dashes with a capped length", () => {
		for (const id of [
			"agent-a",
			"Ägent/../../éte",
			"🤖",
			"x".repeat(128),
			"--weird--id--",
		]) {
			const partition = botSessionPartition(id);
			expect(partition).toMatch(PARTITION_NAME);
			expect(partition.startsWith(BOT_PARTITION_PREFIX)).toBe(true);
			expect(partition.length).toBeLessThanOrEqual(
				BOT_PARTITION_PREFIX.length + 40 + 1 + 16
			);
			expect(partition).not.toContain("--");
		}
	});

	it("never reuses the legacy shared managed-Bot partition", () => {
		expect(botSessionPartition("managed-bots")).not.toBe(
			LEGACY_SHARED_BOT_PARTITION
		);
		expect(LEGACY_SHARED_BOT_PARTITION).toBe("persist:ryu-managed-bots");
	});
});

describe("botProfilePaths", () => {
	const root = join("/data", "managed-bots");

	it("gives two agents separate history, permission, and download folders", () => {
		const first = botProfilePaths(root, "agent-a");
		const second = botProfilePaths(root, "agent-b");
		expect(first.stateDirectory).not.toBe(second.stateDirectory);
		expect(first.downloadDirectory).not.toBe(second.downloadDirectory);
		for (const [mine, theirs] of [
			[first, second],
			[second, first],
		] as const) {
			expect(
				relative(theirs.stateDirectory, mine.downloadDirectory).startsWith("..")
			).toBe(true);
		}
	});

	it("gives the same agent the same folders every time", () => {
		expect(botProfilePaths(root, "agent-a")).toEqual(
			botProfilePaths(root, "agent-a")
		);
	});

	it("keeps ids that sanitize alike in separate folders", () => {
		const folders = new Set(
			["Agent-A", "agent-a", "agent_a", "agent.a", "agent a"].map(
				(id) => botProfilePaths(root, id).stateDirectory
			)
		);
		expect(folders.size).toBe(5);
	});

	it("keeps every agent folder directly inside the agents folder", () => {
		const agentsRoot = join(root, BOT_PROFILES_DIRECTORY);
		for (const id of [
			"agent-a",
			"../../etc",
			`..${sep}..${sep}escape`,
			"/absolute/path",
			"C:\\Users\\x",
			"🤖",
		]) {
			const paths = botProfilePaths(root, id);
			const folder = relative(agentsRoot, paths.stateDirectory);
			expect(folder).toMatch(/^ryu-bot-[a-z0-9-]+$/);
			expect(paths.downloadDirectory).toBe(
				join(paths.stateDirectory, "downloads")
			);
		}
	});

	it("never reuses the legacy shared state file or downloads folder", () => {
		const paths = botProfilePaths(root, "downloads");
		expect(paths.downloadDirectory).not.toBe(join(root, "downloads"));
		expect(paths.stateDirectory).not.toBe(root);
		expect(join(paths.stateDirectory, LEGACY_SHARED_BOT_STATE_FILE)).not.toBe(
			join(root, LEGACY_SHARED_BOT_STATE_FILE)
		);
	});
});
