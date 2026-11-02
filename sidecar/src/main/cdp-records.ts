import { z } from "zod";
import {
	browserAXNodesSchema,
	browserAXPrimitiveNumberSchema,
	browserAXProtocolValueSchema,
} from "./ax-records.ts";
import type { BrowserElementContext } from "./tab-manager.ts";
import { credentialTargetProbeSchema } from "./vault-fill.ts";

export const browserCDPAcknowledgementSchema = z.object({});
export const browserCDPParametersSchema = z.union([
	z.object({ backendNodeId: z.number() }),
	z.object({
		includeUserAgentShadowDOM: z.boolean(),
		x: z.number(),
		y: z.number(),
	}),
	z.object({
		expression: z.string(),
		returnByValue: z.boolean().optional(),
		awaitPromise: z.boolean().optional(),
		userGesture: z.boolean().optional(),
	}),
	z.object({
		type: z.enum(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]),
		x: z.number(),
		y: z.number(),
		button: z.enum(["none", "left", "middle", "right"]).optional(),
		buttons: z.number().optional(),
		clickCount: z.number().optional(),
		deltaX: z.number().optional(),
		deltaY: z.number().optional(),
	}),
	z.object({
		type: z.enum(["keyDown", "keyUp"]),
		code: z.string(),
		key: z.string(),
		nativeVirtualKeyCode: z.number().optional(),
		windowsVirtualKeyCode: z.number().optional(),
		text: z.string().optional(),
		unmodifiedText: z.string().optional(),
	}),
	z.object({ text: z.string() }),
	z.object({ objectId: z.string() }),
	z.object({
		objectId: z.string(),
		functionDeclaration: z.string(),
		arguments: z.array(z.object({ value: z.string() })).optional(),
		returnByValue: z.boolean().optional(),
		awaitPromise: z.boolean().optional(),
	}),
]);
export type BrowserCDPParameters = z.output<typeof browserCDPParametersSchema>;
export const browserCDPAXTreeSchema = z.object({
	nodes: browserAXNodesSchema.optional(),
});
export const browserCDPNodeLocationSchema = z.object({
	backendNodeId: browserAXPrimitiveNumberSchema.optional().catch(undefined),
	frameId: z.string().optional(),
	nodeId: z.number().optional(),
});
const rectangleSchema = z.object({
	height: z.number(),
	width: z.number(),
	x: z.number(),
	y: z.number(),
});
const inspectedElementSchema = z.object({
	attributes: z.record(z.string(), z.string()),
	computed_styles: z.record(z.string(), z.string()),
	rect: rectangleSchema,
	selector: z.string(),
	tag: z.string(),
	xpath: z.string(),
	backend_node_id: z.number().optional(),
	component: z.string().optional(),
	content_preview: z.string().optional(),
	name: z.string().optional(),
	ref: z.string().optional(),
	role: z.string().optional(),
	text: z.string().optional(),
});
export const browserInspectedElementSchema = z.custom<
	z.output<typeof inspectedElementSchema>
>(
	(value) => inspectedElementSchema.safeParse(value).success
) satisfies z.ZodType<BrowserElementContext & { backend_node_id?: number }>;
export const browserCDPInspectionSchema = z.object({
	result: z
		.object({ value: browserInspectedElementSchema.nullable().optional() })
		.optional(),
});
const viewportMetricSchema = browserAXPrimitiveNumberSchema
	.optional()
	.catch(undefined);
const layoutViewportSchema = z.object({
	clientHeight: viewportMetricSchema,
	clientWidth: viewportMetricSchema,
	pageX: viewportMetricSchema,
	pageY: viewportMetricSchema,
});
const visualViewportSchema = layoutViewportSchema.extend({
	offsetX: viewportMetricSchema,
	offsetY: viewportMetricSchema,
	scale: viewportMetricSchema,
	zoom: viewportMetricSchema,
});
export const browserCDPLayoutMetricsSchema = z.object({
	cssLayoutViewport: layoutViewportSchema.optional(),
	cssVisualViewport: visualViewportSchema.optional(),
	layoutViewport: layoutViewportSchema.optional(),
	visualViewport: visualViewportSchema.optional(),
	cssContentSize: rectangleSchema.optional(),
	contentSize: rectangleSchema.optional(),
});
export const browserEditableVerdictSchema = z.object({
	verdict: z.enum(["unknown", "ok", "no"]).optional(),
	why: z.string().optional(),
});
export type BrowserEditableVerdict = z.output<
	typeof browserEditableVerdictSchema
>;
export const browserCDPEditableVerdictSchema = z.object({
	result: z
		.object({ value: browserEditableVerdictSchema.optional() })
		.optional(),
});
export const browserCDPBoxModelSchema = z.object({
	model: z
		.object({
			content: browserAXProtocolValueSchema,
			padding: browserAXProtocolValueSchema,
			border: browserAXProtocolValueSchema,
			margin: browserAXProtocolValueSchema,
			width: z.number().optional(),
			height: z.number().optional(),
		})
		.optional(),
});
export const browserCDPResolvedNodeSchema = z.object({
	object: z.object({ objectId: z.string().optional() }).optional(),
});
export const browserCDPCredentialProbeSchema = z.object({
	result: z
		.object({ value: credentialTargetProbeSchema.optional().catch(undefined) })
		.optional(),
});
/** What the in-page TOTP reader returns: never logged, never sent to the caller. */
export const browserTotpSetupProbeSchema = z.object({
	in_frame: z.boolean(),
	qr: z.string().nullable().optional(),
	media: z
		.object({
			height: z.number(),
			width: z.number(),
			x: z.number(),
			y: z.number(),
		})
		.nullable()
		.optional(),
	detector: z.boolean().optional(),
	text: z.array(z.string()).max(16).optional(),
});
export type BrowserTotpSetupProbe = z.output<
	typeof browserTotpSetupProbeSchema
>;
export const browserCDPTotpSetupProbeSchema = z.object({
	result: z
		.object({ value: browserTotpSetupProbeSchema.optional().catch(undefined) })
		.optional(),
});
export const browserCDPDecodedQrSchema = z.object({
	result: z
		.object({ value: z.string().nullable().optional().catch(null) })
		.optional(),
});
