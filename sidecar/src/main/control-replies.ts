import { z } from "zod";
import { browserTabInfoSchema } from "./browser-records.ts";
import type {
	BrowserAnnotation,
	BrowserContextResult,
	BrowserElementContext,
	BrowserStyleAdjust,
	BrowserWebMCPTool,
	SnapshotElement,
	SnapshotResult,
} from "./tab-manager.ts";
import { browserWebMCPJSONValueSchema } from "./webmcp-records.ts";

function preserveBrowserReply<Schema extends z.ZodType>(schema: Schema) {
	return z.custom<z.output<Schema>>((value) => schema.safeParse(value).success);
}
export const browserControlRectangleSchema = z.object({
	height: z.number(),
	width: z.number(),
	x: z.number(),
	y: z.number(),
});
export const browserStyleAdjustSchema = preserveBrowserReply(
	z.object({
		background_color: z.string().optional(),
		color: z.string().optional(),
		font_family: z.string().optional(),
		font_size: z.string().optional(),
		font_weight: z.string().optional(),
		letter_spacing: z.string().optional(),
		line_height: z.string().optional(),
		margin: z.string().optional(),
		padding: z.string().optional(),
	})
) satisfies z.ZodType<BrowserStyleAdjust>;
export const browserElementContextSchema = preserveBrowserReply(
	z.object({
		attributes: z.record(z.string(), z.string()),
		computed_styles: z.record(z.string(), z.string()),
		rect: browserControlRectangleSchema,
		selector: z.string(),
		tag: z.string(),
		xpath: z.string(),
		component: z.string().optional(),
		content_preview: z.string().optional(),
		name: z.string().optional(),
		ref: z.string().optional(),
		role: z.string().optional(),
		text: z.string().optional(),
	})
) satisfies z.ZodType<BrowserElementContext>;
export const browserSnapshotElementSchema = preserveBrowserReply(
	z.object({
		depth: z.number(),
		name: z.string().optional(),
		props: z
			.record(z.string(), z.union([z.boolean(), z.number(), z.string()]))
			.optional(),
		ref: z.string(),
		role: z.string(),
		value: z.string().optional(),
	})
) satisfies z.ZodType<SnapshotElement>;
export const browserSnapshotResultSchema = preserveBrowserReply(
	z.object({
		elements: z.array(browserSnapshotElementSchema),
		snapshot_id: z.string(),
		tab: browserTabInfoSchema,
		truncated: z.boolean(),
	})
) satisfies z.ZodType<SnapshotResult>;
export const browserWebMCPToolSchema = preserveBrowserReply(
	z.object({
		annotations: z.object({
			consequentialHint: z.boolean(),
			debugging: z.boolean(),
			readOnlyHint: z.boolean(),
			untrustedContentHint: z.boolean(),
		}),
		description: z.string(),
		input_schema: z.string(),
		name: z.string(),
		origin: z.string(),
		title: z.string(),
		tool_id: z.string(),
	})
) satisfies z.ZodType<BrowserWebMCPTool>;
export const browserAnnotationSchema = preserveBrowserReply(
	z.object({
		comment: z.string(),
		created_at: z.string(),
		id: z.string(),
		kind: z.enum(["area", "element", "elements"]),
		rect: browserControlRectangleSchema,
		style: browserStyleAdjustSchema.optional(),
		targets: z.array(browserElementContextSchema),
	})
) satisfies z.ZodType<BrowserAnnotation>;
export const browserControlScreenshotReplySchema = preserveBrowserReply(
	z.object({
		encoding: z.literal("base64"),
		image: z.string(),
		mime: z.literal("image/png"),
	})
);
export const browserContextResultSchema = preserveBrowserReply(
	z.object({
		annotations: z.array(browserAnnotationSchema),
		page: browserTabInfoSchema,
		screenshot: browserControlScreenshotReplySchema.optional(),
		selection: z
			.object({
				rect: browserControlRectangleSchema,
				targets: z.array(browserElementContextSchema),
			})
			.optional(),
		snapshot: browserSnapshotResultSchema,
		viewport: z.object({
			height: z.number(),
			scroll_x: z.number(),
			scroll_y: z.number(),
			width: z.number(),
		}),
		webmcp_tools: z.array(browserWebMCPToolSchema),
	})
) satisfies z.ZodType<BrowserContextResult>;
export const browserControlHealthReplySchema = preserveBrowserReply(
	z.object({
		ok: z.literal(true),
		name: z.literal("ryu-browser"),
		version: z.string(),
		tabs: z.number(),
	})
);
export const browserControlInfoReplySchema = preserveBrowserReply(
	z.object({
		ok: z.literal(true),
		name: z.literal("ryu-browser"),
		version: z.string(),
		capability: z.literal("browser.control"),
	})
);
export const browserControlErrorReplySchema = preserveBrowserReply(
	z.object({ ok: z.literal(false), error: z.string() })
);
export const browserControlTabReplySchema = preserveBrowserReply(
	z.object({ tab: browserTabInfoSchema })
);
export const browserControlTabsReplySchema = preserveBrowserReply(
	z.object({ tabs: z.array(browserTabInfoSchema) })
);
export const browserControlToolsReplySchema = preserveBrowserReply(
	z.object({ tools: z.array(browserWebMCPToolSchema) })
);
export const browserControlWebMCPReplySchema = preserveBrowserReply(
	z.object({
		origin: z.string(),
		result: browserWebMCPJSONValueSchema,
		tool_name: z.string(),
		tool_id: z.string(),
		consequential_hint: z.boolean(),
		debugging_hint: z.boolean(),
		untrusted_content: z.literal(true),
		untrusted_content_hint: z.boolean(),
	})
);
