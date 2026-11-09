// The browser session id the sidecar reports to Core with a credential fill.
//
// When the user attaches vault items to an agent's browser session, Core pins
// that set to the first browser session that fills from it
// (`vault/agent_accounts/fill_sets.rs`). The id is the sidecar's own: one random
// value per lane (tab manager) for the life of this process, never anything the
// agent sends. A restarted browser or another lane therefore reports a different
// id, and Core refuses it the attached items.

import { randomUUID } from "node:crypto";

const laneIds = new WeakMap<object, string>();

/** This lane's browser session id, created on first use. */
export function laneSessionId(lane: object): string {
	const existing = laneIds.get(lane);
	if (existing) {
		return existing;
	}
	const created = `bs_${randomUUID()}`;
	laneIds.set(lane, created);
	return created;
}
