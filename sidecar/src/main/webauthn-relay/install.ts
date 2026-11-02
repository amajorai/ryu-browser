import { type RelayContents, WebAuthnBridge } from "./bridge.ts";
import { type SecurityKeyClient, securityKeyClientFromEnv } from "./client.ts";

/** `ElectronTabManager`'s activity owner for the user's own (visible) lane. */
export const VISIBLE_LANE_OWNER = "visible";

let envClient: SecurityKeyClient | null | undefined;

function defaultClient(): SecurityKeyClient | null {
	if (envClient === undefined) {
		envClient = securityKeyClientFromEnv();
	}
	return envClient;
}

/**
 * Install the security-key relay on one tab, after its debugger is attached
 * and before its first real navigation. `owner` is the tab manager's lane:
 * `"visible"` for the user's window, otherwise the Core-stamped agent id of a
 * Bot lane (the key behind its `persist:ryu-bot-*` partition).
 *
 * Outside Core there is no relay to call, so nothing is installed and pages
 * keep Chromium's own WebAuthn. A failure to install is logged and leaves the
 * tab usable without the relay.
 */
export async function installWebAuthnRelay(
	contents: Electron.WebContents | RelayContents,
	owner: string,
	client: SecurityKeyClient | null = defaultClient()
): Promise<WebAuthnBridge | null> {
	if (!client) {
		return null;
	}
	const bridge = new WebAuthnBridge(
		contents as RelayContents,
		client,
		owner === VISIBLE_LANE_OWNER ? null : owner
	);
	try {
		await bridge.install();
		return bridge;
	} catch (error) {
		bridge.dispose();
		console.error(
			"[ryu-browser] security-key relay could not be installed",
			error
		);
		return null;
	}
}
