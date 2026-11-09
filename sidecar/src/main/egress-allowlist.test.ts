import { describe, expect, it } from "bun:test";
import {
	EgressAllowlistError,
	egressAllowlistHeaderCount,
	egressHostAllowed,
	LaneEgressPolicies,
	MAX_EGRESS_PATTERNS,
	normalizeEgressHost,
	parseEgressAllowlist,
} from "./egress-allowlist.ts";

describe("egress allowlist parsing", () => {
	it("normalizes, de-duplicates, and sorts host patterns", () => {
		expect(
			parseEgressAllowlist(" Example.COM., *.Docs.example.com,example.com ,")
		).toEqual(["*.docs.example.com", "example.com"]);
		expect(parseEgressAllowlist("bücher.de")).toEqual(["xn--bcher-kva.de"]);
		expect(parseEgressAllowlist("[2001:DB8::1]")).toEqual(["2001:db8::1"]);
	});

	it("keeps an absent header distinct from an explicit empty allowlist", () => {
		expect(parseEgressAllowlist(undefined)).toBeNull();
		expect(parseEgressAllowlist("")).toEqual([]);
	});

	it("rejects anything that is not a host or a domain wildcard", () => {
		for (const raw of [
			"example.com:443",
			"https://example.com",
			"example.com/path",
			"user@example.com",
			"*",
			"*.com",
			"*.10.0.0.1",
			"exa mple.com",
			"-bad-.example.com",
			"a.*.example.com",
		]) {
			expect(() => parseEgressAllowlist(raw)).toThrow(EgressAllowlistError);
		}
		const tooMany = Array.from(
			{ length: MAX_EGRESS_PATTERNS + 1 },
			(_, index) => `h${index}.example.com`
		).join(",");
		expect(() => parseEgressAllowlist(tooMany)).toThrow("at most");
	});
});

describe("egress allowlist matching", () => {
	const allowlist = parseEgressAllowlist(
		"example.com,*.cdn.test,93.184.215.14"
	);
	if (!allowlist) {
		throw new Error("fixture must parse");
	}

	it("matches exact hosts and subdomains of a wildcard only", () => {
		expect(egressHostAllowed(allowlist, "EXAMPLE.com.")).toBe(true);
		expect(egressHostAllowed(allowlist, "www.example.com")).toBe(false);
		expect(egressHostAllowed(allowlist, "a.b.cdn.test")).toBe(true);
		expect(egressHostAllowed(allowlist, "cdn.test")).toBe(false);
		expect(egressHostAllowed(allowlist, "evilcdn.test")).toBe(false);
	});

	it("matches IP literals exactly, in any spelling the URL parser accepts", () => {
		expect(egressHostAllowed(allowlist, "93.184.215.14")).toBe(true);
		expect(egressHostAllowed(allowlist, "0x5d.184.215.14")).toBe(true);
		expect(egressHostAllowed(allowlist, "93.184.215.15")).toBe(false);
		expect(normalizeEgressHost("0:0:0:0:0:0:0:1")).toBe("::1");
	});

	it("allows nothing with an empty allowlist", () => {
		expect(egressHostAllowed([], "example.com")).toBe(false);
	});
});

describe("lane egress policies", () => {
	it("leaves a lane unrestricted until Core pins an allowlist", () => {
		const policies = new LaneEgressPolicies();
		expect(policies.allows("bot", "anything.test")).toBe(true);
		policies.admit("bot", null);
		expect(policies.allowlistFor("bot")).toBeNull();
		policies.admit("bot", ["example.com"]);
		expect(policies.allows("bot", "example.com")).toBe(true);
		expect(policies.allows("bot", "anything.test")).toBe(false);
		expect(policies.allows("other-bot", "anything.test")).toBe(true);
	});

	it("keeps a pinned allowlist when a request carries none", () => {
		const policies = new LaneEgressPolicies();
		policies.admit("bot", ["example.com"]);
		policies.admit("bot", null);
		expect(policies.allowlistFor("bot")).toEqual(["example.com"]);
	});

	it("accepts a narrower allowlist and refuses a wider one", () => {
		const policies = new LaneEgressPolicies();
		policies.admit("bot", ["*.example.com", "api.test"]);
		policies.admit("bot", ["*.eu.example.com", "www.example.com"]);
		expect(policies.allowlistFor("bot")).toEqual([
			"*.eu.example.com",
			"www.example.com",
		]);
		expect(() => policies.admit("bot", ["api.test"])).toThrow(
			EgressAllowlistError
		);
		expect(() => policies.admit("bot", ["*.example.com"])).toThrow(
			"cannot be widened"
		);
		policies.admit("bot", []);
		expect(policies.allows("bot", "www.example.com")).toBe(false);
	});
});

describe("egress allowlist header count", () => {
	it("counts every raw header line that names the allowlist, in any case", () => {
		expect(egressAllowlistHeaderCount([])).toBe(0);
		expect(
			egressAllowlistHeaderCount([
				"Host",
				"127.0.0.1:1",
				"X-Ryu-Caller-Egress-Allowlist",
				"example.com",
			])
		).toBe(1);
		expect(
			egressAllowlistHeaderCount([
				"x-ryu-caller-egress-allowlist",
				"example.com",
				"X-RYU-CALLER-EGRESS-ALLOWLIST",
				"*.evil.example",
			])
		).toBe(2);
	});

	it("never mistakes a header value for a header name", () => {
		expect(
			egressAllowlistHeaderCount([
				"x-note",
				"x-ryu-caller-egress-allowlist",
				"x-ryu-caller-egress-allowlist",
				"example.com",
			])
		).toBe(1);
	});
});
