import { z } from "zod";
import {
	browserWebMCPRecordSchema,
	browserWebMCPValueSchema,
} from "./webmcp-records.ts";

/** All control requests are JSON objects; each route validates its owned fields. */
export const browserControlBodySchema = browserWebMCPRecordSchema;
export type BrowserControlBody = z.output<typeof browserControlBodySchema>;
export type BrowserControlValue = z.output<typeof browserWebMCPValueSchema>;
export const browserControlMouseButtonSchema = z.enum([
	"left",
	"middle",
	"right",
]);
export const browserControlScrollDirectionSchema = z.enum([
	"down",
	"left",
	"right",
	"up",
]);
export const browserControlAnnotationKindSchema = z.enum([
	"area",
	"element",
	"elements",
]);
export const browserControlKeysSchema = z
	.array(z.string().refine((value) => value.trim().length > 0))
	.min(1)
	.max(8);
/** Raw native style feedback retains legacy JSON; the publisher filters safe strings. */
const rawStyleInputSchema = z.object({
	background_color: browserWebMCPValueSchema,
	color: browserWebMCPValueSchema,
	font_family: browserWebMCPValueSchema,
	font_size: browserWebMCPValueSchema,
	font_weight: browserWebMCPValueSchema,
	letter_spacing: browserWebMCPValueSchema,
	line_height: browserWebMCPValueSchema,
	margin: browserWebMCPValueSchema,
	padding: browserWebMCPValueSchema,
});
export const browserRawStyleInputSchema = z.custom<
	z.output<typeof rawStyleInputSchema>
>((value) => rawStyleInputSchema.safeParse(value).success);
export type BrowserRawStyleInput = z.output<typeof browserRawStyleInputSchema>;
export function browserControlString(
	value: BrowserControlValue
): string | undefined {
	const parsed = z.string().safeParse(value);
	return parsed.success ? parsed.data : undefined;
}
