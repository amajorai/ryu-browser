import { z } from "zod";
import type { AXNodeLike, AXValueLike } from "./ax-snapshot.ts";

/** CDP transports accessibility values as JSON, including nested related-node data. */
export const browserAXProtocolValueSchema = z.json().optional();
export type BrowserAXProtocolValue = z.output<
	typeof browserAXProtocolValueSchema
>;
/** Preserve the existing pure projection's handling of every JavaScript number. */
export const browserAXPrimitiveNumberSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
export const browserAXQuadSchema = z.array(z.json());
const axValueSchema = z.object({
	type: z.string().optional(),
	value: browserAXProtocolValueSchema,
});
export const browserAXValueSchema = z.custom<AXValueLike>(
	(value) => axValueSchema.safeParse(value).success
);
const axNodeSchema = z.object({
	backendDOMNodeId: z.number().optional(),
	childIds: z.array(z.string()).optional(),
	ignored: z.boolean().optional(),
	name: browserAXValueSchema.optional(),
	nodeId: z.string(),
	parentId: z.string().optional(),
	properties: z
		.array(z.object({ name: z.string(), value: browserAXValueSchema }))
		.optional(),
	role: browserAXValueSchema.optional(),
	value: browserAXValueSchema.optional(),
});
export const browserAXNodeSchema = z.custom<AXNodeLike>(
	(value) => axNodeSchema.safeParse(value).success
);
export const browserAXNodesSchema = z.array(browserAXNodeSchema);
export const browserAXTreeResponseSchema = z.object({
	nodes: browserAXNodesSchema,
});
