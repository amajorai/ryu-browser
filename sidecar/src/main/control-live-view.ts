// Control routes for the read-only Bot-lane live view (`bot-live-view.ts`).
//
//   GET    /lanes                                  every open Bot lane and its tabs
//   GET    /lanes/:agent/tabs/:tab/screencast      the latest frame of one lane tab
//   DELETE /lanes/:agent/tabs/:tab/screencast      stop watching that tab
//
// These are the owner's view of their agents' hidden lanes. An agent lane can
// never use them (it would see other agents' pages), they never create a lane
// or a tab, and they send no input.

import type {
	BotLiveViews,
	LiveViewResult,
	LiveViewSource,
} from "./bot-live-view.ts";
import { type ControlResponse, notFound, tabView } from "./control-parsing.ts";
import type { TabInfo } from "./tab-manager.ts";

export interface LiveViewLane {
	agentId: string;
	tabs: TabInfo[];
}

/** What the live-view routes need from the Bot lanes and the running views. */
export interface LiveViewDeps {
	/** The latest frame of a lane tab, starting its view on first use. */
	frame(
		agentId: string,
		tabId: string,
		source: LiveViewSource
	): Promise<LiveViewResult>;
	/** Every open Bot lane, without creating one. */
	lanes(): LiveViewLane[];
	/** One open lane's tab as a live-view source; null when lane or tab is absent. */
	source(agentId: string, tabId: string): LiveViewSource | null;
	/** Stop a lane tab's view; false when none was running. */
	stop(agentId: string, tabId: string): boolean;
}

/** The Bot lanes as the live view reads them (`BrowserSessionRouter`). */
export interface LiveViewLanes {
	lanes(): LiveViewLane[];
	liveViewSource(agentId: string, tabId: string): LiveViewSource | null;
}

/**
 * Join the Bot lanes (null until they exist, or after shutdown) to the
 * running views. A lane name is the router's normalized agent id.
 */
export function laneLiveViewDeps(
	lanes: () => LiveViewLanes | null,
	views: BotLiveViews
): LiveViewDeps {
	return {
		frame: (agentId, tabId, source) =>
			views.frame(agentId.trim(), tabId, source),
		lanes: () => lanes()?.lanes() ?? [],
		source: (agentId, tabId) => lanes()?.liveViewSource(agentId, tabId) ?? null,
		stop: (agentId, tabId) => views.stop(agentId.trim(), tabId),
	};
}

const SCREENCAST_ROUTE = /^\/lanes\/([^/]+)\/tabs\/([^/]+)\/screencast$/;

/** Handle a `/lanes` route, or return null for any other path. */
export async function handleLiveViewRoute(
	method: string,
	path: string,
	agentId: string | undefined,
	deps: LiveViewDeps | undefined
): Promise<ControlResponse | null> {
	if (path !== "/lanes" && !path.startsWith("/lanes/")) {
		return null;
	}
	if (agentId !== undefined) {
		return {
			status: 403,
			json: { ok: false, error: "an agent cannot view Bot lanes" },
		};
	}
	if (path === "/lanes") {
		if (method !== "GET") {
			return notFound();
		}
		const lanes = deps?.lanes() ?? [];
		return {
			status: 200,
			json: {
				lanes: lanes.map((lane) => ({
					agent_id: lane.agentId,
					tabs: lane.tabs.map(tabView),
				})),
			},
		};
	}
	const match = path.match(SCREENCAST_ROUTE);
	if (!(match && deps)) {
		return notFound();
	}
	let lane: string;
	let tabId: string;
	try {
		lane = decodeURIComponent(match[1]);
		tabId = decodeURIComponent(match[2]);
	} catch {
		return notFound();
	}
	if (method === "DELETE") {
		return { status: 200, json: { ok: true, stopped: deps.stop(lane, tabId) } };
	}
	if (method !== "GET") {
		return notFound();
	}
	const source = deps.source(lane, tabId);
	if (!source) {
		// The tab closed (or the lane never existed): release any view of it.
		deps.stop(lane, tabId);
		return {
			status: 404,
			json: { ok: false, error: "no such Bot lane tab" },
		};
	}
	try {
		const result = await deps.frame(lane, tabId, source);
		if (result.kind === "busy") {
			return {
				status: 429,
				json: {
					ok: false,
					error: "too many live views are open; close one and try again",
				},
			};
		}
		return { status: 200, json: { ok: true, frame: result.frame } };
	} catch {
		return {
			status: 502,
			json: { ok: false, error: "live view could not start for this tab" },
		};
	}
}
