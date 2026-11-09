import { describe, expect, it } from "bun:test";
import {
	assertNoProxyBypass,
	disableSecureDns,
	NON_PROXIED_UDP_POLICY,
	pinWebRtcToProxy,
	proxyBypassSwitches,
} from "./chromium-egress-hardening.ts";

function commandLine(switches: Record<string, string>) {
	return {
		getSwitchValue: (name: string) => switches[name] ?? "",
		hasSwitch: (name: string) => name in switches,
	};
}

describe("Chromium proxy bypass settings", () => {
	it("accepts a command line that leaves the session proxy in charge", () => {
		const clean = commandLine({
			"enable-features": "WebMCP",
			"password-store": "gnome-libsecret",
		});
		expect(proxyBypassSwitches(clean)).toEqual([]);
		expect(() => assertNoProxyBypass(clean)).not.toThrow();
	});

	it("names every switch that routes around the proxy or its resolver", () => {
		const bypassing = commandLine({
			"enable-features": "Foo,DnsOverHttps<Trial",
			"host-resolver-rules": "MAP * 1.2.3.4",
			"no-proxy-server": "",
			"webrtc-ip-handling-policy": "default",
		});
		expect(proxyBypassSwitches(bypassing)).toEqual([
			"no-proxy-server",
			"host-resolver-rules",
			"webrtc-ip-handling-policy",
			"enable-features=DnsOverHttps",
		]);
		expect(() => assertNoProxyBypass(bypassing)).toThrow(
			"Bot browser sessions stay closed"
		);
	});
});

describe("Chromium resolver and WebRTC policy", () => {
	it("turns DNS over HTTPS off", () => {
		let configured: unknown = null;
		disableSecureDns({
			configureHostResolver: (options) => {
				configured = options;
			},
		});
		expect(configured).toEqual({ secureDnsMode: "off", secureDnsServers: [] });
	});

	it("pins WebRTC to proxied traffic and fails when Chromium ignores it", () => {
		let policy = "default";
		const obeys = {
			getWebRTCIPHandlingPolicy: () => policy,
			setWebRTCIPHandlingPolicy: (next: string) => {
				policy = next;
			},
		};
		pinWebRtcToProxy(obeys);
		expect(policy).toBe(NON_PROXIED_UDP_POLICY);
		const ignores = {
			getWebRTCIPHandlingPolicy: () => "default",
			setWebRTCIPHandlingPolicy: () => undefined,
		};
		expect(() => pinWebRtcToProxy(ignores)).toThrow("WebRTC");
	});
});
