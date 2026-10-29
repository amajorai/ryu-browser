import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * The one Chromium partition every managed Bot shared before each agent got
 * its own. Nothing browses in it any more; its leftover cookies and site
 * storage are cleared once (see `LEGACY_BOT_PARTITION_CLEARED_MARKER`).
 */
export const LEGACY_SHARED_BOT_PARTITION = "persist:ryu-managed-bots";

/** File in the managed-Bot state folder recording that the legacy jar was cleared. */
export const LEGACY_BOT_PARTITION_CLEARED_MARKER =
	"legacy-shared-session-cleared";

/** Prefix shared by every per-agent managed-Bot Chromium partition. */
export const BOT_PARTITION_PREFIX = "persist:ryu-bot-";

/** Longest readable agent-id stem kept in a partition name. */
const MAX_READABLE_STEM = 40;

/** Hex characters of the agent-id digest appended to every partition name. */
const DIGEST_LENGTH = 16;

const DISALLOWED_PARTITION_CHARS = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/**
 * Map a Core-stamped agent id to its own persistent Chromium partition, so each
 * agent keeps a separate cookie jar, login state, and site storage.
 *
 * The readable stem is limited to `[a-z0-9-]` (runs of anything else, dashes
 * included, collapse to one dash) and capped in length; a digest of
 * the full id is always appended, so ids that only differ in case, punctuation,
 * or past the cap never share a partition. The same id always maps to the same
 * partition, so an agent's logins survive restarts.
 */
export function botSessionPartition(agentId: string): string {
	const stem = agentId
		.toLowerCase()
		.replace(DISALLOWED_PARTITION_CHARS, "-")
		.slice(0, MAX_READABLE_STEM)
		.replace(EDGE_DASHES, "");
	const digest = createHash("sha256")
		.update(agentId, "utf8")
		.digest("hex")
		.slice(0, DIGEST_LENGTH);
	return `${BOT_PARTITION_PREFIX}${stem ? `${stem}-` : ""}${digest}`;
}

/** Folder, under the managed-Bot state root, that holds one folder per agent. */
export const BOT_PROFILES_DIRECTORY = "agents";

/**
 * Files the managed-Bot state root held while every agent shared one store:
 * the shared browsing history, saved site permissions, and download list.
 * Nothing reads it any more; it is deleted so one agent's history and
 * permissions never carry into another agent's profile.
 */
export const LEGACY_SHARED_BOT_STATE_FILE = "browser-state.json";

export interface BotProfilePaths {
	/** Where the agent's downloads are saved. */
	readonly downloadDirectory: string;
	/** Holds the agent's browsing history, site permissions, and download list. */
	readonly stateDirectory: string;
}

/**
 * Map a Core-stamped agent id to its own state and downloads folders under the
 * managed-Bot root, so each agent keeps a separate browsing history, set of
 * saved site permissions, and downloads folder, alongside its own cookie jar.
 *
 * The folder name is the agent's partition name without `persist:`, so it is
 * limited to `[a-z0-9-]`, never contains a path separator or `..`, and two ids
 * never share a folder.
 */
export function botProfilePaths(
	root: string,
	agentId: string
): BotProfilePaths {
	const folder = botSessionPartition(agentId).slice("persist:".length);
	const stateDirectory = join(root, BOT_PROFILES_DIRECTORY, folder);
	return {
		downloadDirectory: join(stateDirectory, "downloads"),
		stateDirectory,
	};
}
