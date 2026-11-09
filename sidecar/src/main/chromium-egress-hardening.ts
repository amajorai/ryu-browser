// Chromium settings that would let a managed Bot lane reach the network without
// going through its guarded SOCKS proxy, and the checks that refuse them.
//
// * Proxy and resolver switches on the process command line override or route
//   around the per-session proxy (`--no-proxy-server`, `--proxy-bypass-list`,
//   `--host-resolver-rules`, …). While any is present, Bot lanes do not open.
// * DNS over HTTPS lets Chromium resolve names itself instead of leaving them to
//   the proxy, so the secure resolver is turned off for the whole browser.
// * WebRTC can send UDP straight from the machine, which a SOCKS proxy never
//   sees. Every Bot tab is pinned to `disable_non_proxied_udp`, and a tab whose
//   contents do not report that policy is closed before it loads anything.

/** Switches that change where Chromium sends traffic or how it resolves names. */
export const PROXY_BYPASS_SWITCHES = [
	"proxy-server",
	"no-proxy-server",
	"proxy-pac-url",
	"proxy-auto-detect",
	"proxy-bypass-list",
	"host-resolver-rules",
	"host-rules",
	"webrtc-ip-handling-policy",
	"force-webrtc-ip-handling-policy",
] as const;

/** Chromium features that turn secure DNS on despite the resolver setting. */
const SECURE_DNS_FEATURES = ["DnsOverHttps", "DnsHttpssvc"];

/** The only WebRTC policy that keeps a Bot lane's media behind its proxy. */
export const NON_PROXIED_UDP_POLICY = "disable_non_proxied_udp";

export interface ChromiumCommandLine {
	getSwitchValue(name: string): string;
	hasSwitch(name: string): boolean;
}

/** Every command-line setting present that would bypass a session proxy. */
export function proxyBypassSwitches(
	commandLine: ChromiumCommandLine
): string[] {
	const present: string[] = PROXY_BYPASS_SWITCHES.filter((name) =>
		commandLine.hasSwitch(name)
	);
	if (commandLine.hasSwitch("enable-features")) {
		const features = commandLine
			.getSwitchValue("enable-features")
			.split(",")
			.map((feature) => feature.trim().split("<")[0] ?? "");
		for (const feature of SECURE_DNS_FEATURES) {
			if (features.includes(feature)) {
				present.push(`enable-features=${feature}`);
			}
		}
	}
	return present;
}

/** Throw when the process carries a setting that would bypass the guard. */
export function assertNoProxyBypass(commandLine: ChromiumCommandLine): void {
	const present = proxyBypassSwitches(commandLine);
	if (present.length > 0) {
		throw new Error(
			`Bot browser sessions stay closed while Chromium runs with ${present.join(", ")}`
		);
	}
}

export interface HostResolverConfigurable {
	configureHostResolver(options: {
		secureDnsMode?: "off" | "automatic" | "secure";
		secureDnsServers?: string[];
	}): void;
}

/** Turn DNS over HTTPS off so names are resolved where the proxy screens them. */
export function disableSecureDns(electronApp: HostResolverConfigurable): void {
	electronApp.configureHostResolver({
		secureDnsMode: "off",
		secureDnsServers: [],
	});
}

export interface WebRtcPolicyContents {
	getWebRTCIPHandlingPolicy(): string;
	setWebRTCIPHandlingPolicy(
		policy:
			| "default"
			| "default_public_interface_only"
			| "default_public_and_private_interfaces"
			| "disable_non_proxied_udp"
	): void;
}

/** Keep WebRTC behind the proxy, and fail when Chromium did not take the policy. */
export function pinWebRtcToProxy(contents: WebRtcPolicyContents): void {
	contents.setWebRTCIPHandlingPolicy(NON_PROXIED_UDP_POLICY);
	if (contents.getWebRTCIPHandlingPolicy() !== NON_PROXIED_UDP_POLICY) {
		throw new Error("Bot browser tab could not keep WebRTC behind its proxy");
	}
}
