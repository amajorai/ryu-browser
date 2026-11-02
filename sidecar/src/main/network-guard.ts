// The guarded network path every Chromium session uses.

import type { Session } from "electron";
import { safeNavigationUrlResolved } from "./control.ts";

/** Every loopback spelling a page could use to reach a local service. */
const NETWORK_GUARD_PROBES = [
	"http://127.0.0.1/",
	"http://localhost/",
	"http://[::1]/",
];

/**
 * Send every request from a Chromium session through the guarded SOCKS proxy,
 * and fail closed when Chromium does not report the proxy as effective.
 */
export async function routeThroughNetworkGuard(
	browserSession: Session,
	port: number
): Promise<void> {
	await browserSession.setProxy({
		mode: "fixed_servers",
		proxyRules: `socks5://127.0.0.1:${port}`,
		proxyBypassRules: "<-loopback>",
	});
	// Since Electron 45, `setProxy` can resolve before Chromium applies the new
	// config, so the first lookup in a fresh process still answers DIRECT. Reload
	// it so the guard is in effect before any check or page load.
	await browserSession.forceReloadProxyConfig();
	for (const probe of NETWORK_GUARD_PROBES) {
		const effective = await browserSession.resolveProxy(probe);
		if (effective !== `SOCKS5 127.0.0.1:${port}`) {
			throw new Error("browser network guard is not active");
		}
	}
}

/** Re-screen every Chromium main-frame navigation, including redirect hops. */
export function installNavigationGuard(browserSession: Session): void {
	browserSession.webRequest.onBeforeRequest(
		{ urls: ["http://*/*", "https://*/*"] },
		(details, callback) => {
			if (
				details.resourceType !== "mainFrame" &&
				details.resourceType !== "subFrame"
			) {
				callback({ cancel: false });
				return;
			}
			void safeNavigationUrlResolved(details.url)
				.then(() => callback({ cancel: false }))
				.catch(() => callback({ cancel: true }));
		}
	);
}
