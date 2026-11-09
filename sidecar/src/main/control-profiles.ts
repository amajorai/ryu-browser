// Control routes for managed-Bot profiles and lane sessions.
//
//   GET    /profiles               every Bot profile on disk (owner only)
//   DELETE /profiles/:id           delete one profile (owner only)
//   GET    /profiles/:id/export    one profile's reviewable state (owner only)
//   GET    /sessions               open lane sessions: an agent sees only its own
//   DELETE /sessions/current       an agent closes its own lane
//
// A profile is an agent's persistent Chromium partition plus its state folder
// (`bot-profiles.ts`); a session is its open lane, identified by the browser
// session id the lane reports with a credential fill (`lane-session.ts`). None
// of these routes opens a lane. An agent can never list, export or delete a
// profile (it would reach other agents' sign-ins), and an export never carries
// a cookie value or site storage.

import { join } from "node:path";
import {
	botProfileExport,
	botProfileIds,
	botProfilesRoot,
	type ChromiumCookie,
	directoryBytes,
	isBotProfileId,
	readBotProfileState,
} from "./bot-profiles.ts";
import { type ControlResponse, notFound, tabView } from "./control-parsing.ts";
import { laneSessionId } from "./lane-session.ts";
import type { TabManager } from "./tab-manager.ts";

/** What the profile routes need from the Bot lanes (`BrowserSessionRouter`). */
export interface ProfileLanes {
	closeLane(agentId: string): boolean;
	deleteProfile(id: string): Promise<boolean>;
	managedBotsRoot(): string;
	openProfiles(): Map<string, { agentId: string; tabs: TabManager }>;
	profileCookies(id: string): Promise<ChromiumCookie[]>;
}

const PROFILE_ROUTE = /^\/profiles\/([^/]+)$/;
const EXPORT_ROUTE = /^\/profiles\/([^/]+)\/export$/;

function forbidden(error: string): ControlResponse {
	return { status: 403, json: { ok: false, error } };
}

function sessionView(profile: string, agentId: string, tabs: TabManager) {
	return {
		agent_id: agentId,
		id: laneSessionId(tabs),
		profile,
		tabs: tabs.list().map(tabView),
	};
}

function profileSummaries(lanes: ProfileLanes) {
	const root = lanes.managedBotsRoot();
	const open = lanes.openProfiles();
	const ids = new Set([...botProfileIds(root), ...open.keys()]);
	return [...ids].sort().map((id) => {
		const folder = join(botProfilesRoot(root), id);
		const state = readBotProfileState(folder);
		const lane = open.get(id);
		return {
			agent_id: lane?.agentId ?? null,
			browser_session: lane ? laneSessionId(lane.tabs) : null,
			bytes: directoryBytes(folder),
			downloads: state.downloads.length,
			history_entries: state.history.length,
			id,
			open: lane !== undefined,
			site_permissions: state.sitePermissions.length,
			tabs: lane ? lane.tabs.list().length : 0,
		};
	});
}

function decodedId(match: RegExpMatchArray | null): string | null {
	if (!match) {
		return null;
	}
	try {
		const id = decodeURIComponent(match[1]);
		return isBotProfileId(id) ? id : null;
	} catch {
		return null;
	}
}

async function handleProfiles(
	method: string,
	path: string,
	lanes: ProfileLanes | null
): Promise<ControlResponse> {
	if (path === "/profiles") {
		if (method !== "GET") {
			return notFound();
		}
		return {
			status: 200,
			json: { profiles: lanes ? profileSummaries(lanes) : [] },
		};
	}
	const exportId = decodedId(path.match(EXPORT_ROUTE));
	if (exportId !== null) {
		if (method !== "GET") {
			return notFound();
		}
		const known =
			lanes &&
			(botProfileIds(lanes.managedBotsRoot()).includes(exportId) ||
				lanes.openProfiles().has(exportId));
		if (!(lanes && known)) {
			return { status: 404, json: { ok: false, error: "no such profile" } };
		}
		const folder = join(botProfilesRoot(lanes.managedBotsRoot()), exportId);
		const cookies = await lanes.profileCookies(exportId);
		return {
			status: 200,
			json: botProfileExport(
				exportId,
				readBotProfileState(folder),
				cookies,
				new Date()
			),
		};
	}
	const deleteId = decodedId(path.match(PROFILE_ROUTE));
	if (deleteId === null || method !== "DELETE") {
		return notFound();
	}
	if (!(lanes && (await lanes.deleteProfile(deleteId)))) {
		return {
			status: 404,
			json: { ok: false, error: "no such profile, or its lane is opening" },
		};
	}
	return { status: 200, json: { deleted: deleteId, ok: true } };
}

function handleSessions(
	method: string,
	path: string,
	agentId: string | undefined,
	lanes: ProfileLanes | null
): ControlResponse {
	const open = lanes ? [...lanes.openProfiles()] : [];
	if (path === "/sessions") {
		if (method !== "GET") {
			return notFound();
		}
		const visible = open.filter(
			([, lane]) => agentId === undefined || lane.agentId === agentId.trim()
		);
		return {
			status: 200,
			json: {
				sessions: visible.map(([profile, lane]) =>
					sessionView(profile, lane.agentId, lane.tabs)
				),
			},
		};
	}
	if (path !== "/sessions/current" || method !== "DELETE") {
		return notFound();
	}
	if (agentId === undefined) {
		return {
			status: 400,
			json: {
				ok: false,
				error:
					"only an agent's own browser session can be closed; close the shared browser's tabs instead",
			},
		};
	}
	return {
		status: 200,
		json: { closed: lanes?.closeLane(agentId) ?? false, ok: true },
	};
}

/** Handle a `/profiles` or `/sessions` route, or return null for any other path. */
export function handleProfileRoute(
	method: string,
	path: string,
	agentId: string | undefined,
	lanes: (() => ProfileLanes | null) | undefined
): Promise<ControlResponse> | ControlResponse | null {
	const isProfiles = path === "/profiles" || path.startsWith("/profiles/");
	const isSessions = path === "/sessions" || path.startsWith("/sessions/");
	if (!(isProfiles || isSessions)) {
		return null;
	}
	const resolved = lanes?.() ?? null;
	if (isSessions) {
		return handleSessions(method, path, agentId, resolved);
	}
	if (agentId !== undefined) {
		return forbidden("an agent cannot manage browser profiles");
	}
	return handleProfiles(method, path, resolved);
}
