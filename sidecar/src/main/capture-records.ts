import { z } from "zod";
import type { BrowserActivityMessage } from "./activity.ts";

/** CDP carries JSON protocol parameters; capture observes only these event fields. */
export const browserCaptureProtocolValueSchema = z.json().optional();
export type BrowserCaptureProtocolValue = z.output<
	typeof browserCaptureProtocolValueSchema
>;
export const browserCaptureProtocolRecordSchema = z.record(
	z.string(),
	z.json()
);
export type BrowserCaptureProtocolRecord = z.output<
	typeof browserCaptureProtocolRecordSchema
>;
export const browserCaptureContextCreatedSchema = z.object({
	context: z.object({
		id: z.number().refine(Number.isSafeInteger),
		auxData: z.object({ isDefault: z.literal(true) }),
	}),
});
export const browserCaptureContextDestroyedSchema = z.object({
	executionContextId: z.number(),
});
export const browserCaptureBindingSchema = z.object({
	executionContextId: z.number(),
	name: z.literal("__ryuBrowserActivity"),
	payload: z.string(),
});
export const browserCapturePayloadSchema = z.string().max(256).optional();
export type BrowserCapturePayload = z.output<
	typeof browserCapturePayloadSchema
>;
const activityMessageSchema = z.object({
	action: z.enum(["start", "clone", "stop"]),
	capability: z.string().min(1),
	kind: z.enum(["camera", "microphone", "screen"]),
	sourceId: z.string().max(128).optional(),
	trackId: z.number().positive().refine(Number.isSafeInteger),
});
export const browserActivityMessageSchema = z.custom<
	z.output<typeof activityMessageSchema>
>(
	(value) => activityMessageSchema.safeParse(value).success
) satisfies z.ZodType<BrowserActivityMessage>;
