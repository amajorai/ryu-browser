import { z } from "zod";

/** Native JSON.parse may produce infinite numbers from valid exponent syntax. */
const nativeJSONGrammar: z.ZodType<z.core.util.JSONType> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.literal(Number.POSITIVE_INFINITY),
		z.literal(Number.NEGATIVE_INFINITY),
		z.boolean(),
		z.null(),
		z.array(browserWebMCPJSONValueSchema),
		z.record(z.string(), browserWebMCPJSONValueSchema),
	])
);
/** Validate JSON without cloning page results or dropping additive metadata. */
export const browserWebMCPJSONValueSchema: z.ZodType<z.core.util.JSONType> =
	z.custom<z.output<typeof nativeJSONGrammar>>((value) => {
		if (!nativeJSONGrammar.safeParse(value).success) {
			return false;
		}
		if (!z.record(z.string(), z.unknown()).safeParse(value).success) {
			return true;
		}
		const ownPrototypeField = Object.getOwnPropertyDescriptor(
			value,
			"__proto__"
		);
		return (
			ownPrototypeField === undefined ||
			browserWebMCPJSONValueSchema.safeParse(ownPrototypeField.value).success
		);
	});
export type BrowserWebMCPJSONValue = z.output<
	typeof browserWebMCPJSONValueSchema
>;
export const browserWebMCPValueSchema = browserWebMCPJSONValueSchema.optional();
export type BrowserWebMCPValue = z.output<typeof browserWebMCPValueSchema>;
const recordSchema = z.record(z.string(), browserWebMCPJSONValueSchema);
export const browserWebMCPRecordSchema = z.custom<
	z.output<typeof recordSchema>
>(
	(value) =>
		recordSchema.safeParse(value).success &&
		browserWebMCPJSONValueSchema.safeParse(value).success
);
export type BrowserWebMCPRecord = z.output<typeof browserWebMCPRecordSchema>;
const argumentsSchema = z.record(z.string(), browserWebMCPValueSchema);
export const browserWebMCPArgumentsSchema = z.custom<
	z.output<typeof argumentsSchema>
>((value) => argumentsSchema.safeParse(value).success);
export type BrowserWebMCPArguments = z.output<
	typeof browserWebMCPArgumentsSchema
>;
const envelopeSchema = z.object({
	__ryuWebMCPResult: z.literal(true),
	serializedResult: browserWebMCPValueSchema,
	value: browserWebMCPJSONValueSchema,
});
export const browserWebMCPResultEnvelopeSchema = z.custom<
	z.output<typeof envelopeSchema>
>((value) => envelopeSchema.safeParse(value).success);
