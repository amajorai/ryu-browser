/**
 * The subject after "·" in an activity-center row: the tab's title, or who is
 * driving the browser for a computer-use entry.
 *
 * The main process has no translator for these, so it leaves an untitled tab's
 * title empty and keys a computer-use entry by its owner
 * (`computer-use:<owner>`, `main/activity.ts`). The English `agentLabel` it
 * also sends is for the control API, not for display.
 */
import { tl } from "../i18n/shell-i18n.ts";
import type { BrowserActivity } from "../main/activity.ts";

/** The visible window's own tab manager, as opposed to a bot-session lane. */
const VISIBLE_COMPUTER_USE_ID = "computer-use:visible";

export function activitySubject(activity: BrowserActivity): string {
	if (activity.source === "computer-use") {
		return activity.id === VISIBLE_COMPUTER_USE_ID ? "Ryu" : tl("Ryu agent");
	}
	return activity.tabTitle || tl("New tab");
}
