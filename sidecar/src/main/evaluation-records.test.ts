import { describe, expect, it } from "bun:test";
import { browserEvaluationEnvelopeSchema } from "./evaluation-records.ts";

describe("native privileged evaluation HTTP results", () => {
	it("keeps complete native JSON results, additive data and nested identity", () => {
		const result = JSON.parse(
			'{"__proto__":{"retained":true},"nested":[{"ok":true}]}'
		);
		const parsed = browserEvaluationEnvelopeSchema.parse({ result });
		expect(parsed.result).toBe(result);
		expect(Object.hasOwn(result, "__proto__")).toBe(true);
	});
	it("preserves the original HTTP bytes for every serializable SDK value", () => {
		for (const result of [
			undefined,
			null,
			true,
			false,
			42,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			"Native text",
			[1, undefined, Number.NaN],
			{ optional: undefined, value: Number.NaN },
			new Date("2026-10-07T00:00:00Z"),
			/native/,
			() => 42,
			Symbol("native"),
			{ toJSON: (key: string) => ({ nativeKey: key }) },
		]) {
			const original = JSON.stringify({ result });
			const parsed = browserEvaluationEnvelopeSchema.parse({ result });
			expect(JSON.stringify({ result: parsed.result })).toBe(original);
		}
	});
});
