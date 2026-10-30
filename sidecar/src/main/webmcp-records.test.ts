import { describe, expect, it } from "bun:test";
import { decodeWebMCPResult } from "./webmcp.ts";
import {
	browserWebMCPJSONValueSchema,
	browserWebMCPResultEnvelopeSchema,
} from "./webmcp-records.ts";

describe("native WebMCP result contracts", () => {
	it("retains result identity, additive metadata and own prototype-named JSON", () => {
		const value = JSON.parse(
			'{"__proto__":{"retained":true},"nested":[{"ok":true}]}'
		);
		expect(browserWebMCPJSONValueSchema.parse(value)).toBe(value);
		expect(decodeWebMCPResult(value)).toBe(value);
		expect(Object.hasOwn(value, "__proto__")).toBe(true);
		const envelope = {
			__ryuWebMCPResult: true as const,
			value,
			serializedResult: false,
			nativeMetadata: { channel: "page" },
		};
		expect(browserWebMCPResultEnvelopeSchema.parse(envelope)).toBe(envelope);
	});
	it("preserves valid native JSON exponent overflow and serialized envelopes", () => {
		expect(decodeWebMCPResult("1e999")).toBe(Number.POSITIVE_INFINITY);
		expect(decodeWebMCPResult('{"nested":-1e999}')).toEqual({
			nested: Number.NEGATIVE_INFINITY,
		});
		expect(
			decodeWebMCPResult(
				'{"__ryuWebMCPResult":true,"serializedResult":true,"value":"1e999"}'
			)
		).toBe(Number.POSITIVE_INFINITY);
	});
	it("rejects values that cannot cross the JSON result transport", () => {
		const invalidPrototypeField = Object.defineProperty({}, "__proto__", {
			value: () => 42,
			enumerable: true,
		});
		for (const value of [
			() => 42,
			Symbol("native"),
			{ callback: () => 42 },
			Number.NaN,
			invalidPrototypeField,
			{ nested: invalidPrototypeField },
		]) {
			expect(browserWebMCPJSONValueSchema.safeParse(value).success).toBe(false);
		}
	});
});
