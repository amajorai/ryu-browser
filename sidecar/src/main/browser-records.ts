import { z } from "zod";
import type { BrowserActivity } from "./activity.ts";
import type {
	BrowserDownloadEntry,
	BrowserExtension,
	BrowserHistoryEntry,
	BrowserSettings,
	BrowserState,
	BrowserTabState,
	SitePermission,
} from "./browser-state.ts";

/** Validate the actual native publisher while retaining its record and extra fields. */
function preserveBrowserRecord<Schema extends z.ZodType>(schema: Schema) {
	return z.custom<z.output<Schema>>((value) => schema.safeParse(value).success);
}

export const browserPermissionSchema = z.enum([
	"camera",
	"microphone",
	"geolocation",
	"notifications",
	"clipboard-read",
]);
export const browserSurfaceSchema = z.enum([
	"browser",
	"settings",
	"history",
	"downloads",
	"passwords",
	"permissions",
]);
const browserLinkDestinationSchema = z.enum(["default", "ryu"]);
const browserApprovalSchema = z.enum(["always-allow", "always-ask"]);
const browserAnnotationPolicySchema = z.enum(["always", "ask", "never"]);

export const browserSitePermissionSchema = preserveBrowserRecord(
	z.object({
		decision: z.enum(["allow", "deny"]),
		origin: z.string().min(1),
		permission: browserPermissionSchema,
	})
) satisfies z.ZodType<SitePermission>;
export const browserSettingsSchema = preserveBrowserRecord(
	z.object({
		allowControl: z.boolean(),
		annotationScreenshots: browserAnnotationPolicySchema,
		approval: browserApprovalSchema,
		askWhereToSave: z.boolean(),
		developerCdp: z.boolean(),
		downloadDirectory: z.string(),
		historyAccess: browserApprovalSchema,
		localLinkDestination: browserLinkDestinationSchema,
		sitePermissions: z.array(browserSitePermissionSchema),
		webLinkDestination: browserLinkDestinationSchema,
	})
) satisfies z.ZodType<BrowserSettings>;

const browserActivityBase = {
	detail: z.string(),
	id: z.string(),
	startedAt: z.number(),
	status: z.enum(["active", "recent"]),
	updatedAt: z.number(),
};
export const browserActivitySchema = preserveBrowserRecord(
	z.union([
		z.object({
			...browserActivityBase,
			kind: z.enum(["audio", "camera", "microphone", "screen"]),
			selectable: z.boolean(),
			source: z.literal("browser-tab"),
			tabId: z.string(),
			tabTitle: z.string(),
			tabUrl: z.string(),
		}),
		z.object({
			...browserActivityBase,
			agentLabel: z.string(),
			kind: z.literal("computer-use"),
			selectable: z.literal(false),
			source: z.literal("computer-use"),
			tabId: z.string().optional(),
			tabTitle: z.string().optional(),
		}),
	])
) satisfies z.ZodType<BrowserActivity>;
export const browserHistoryEntrySchema = preserveBrowserRecord(
	z.object({
		id: z.string(),
		title: z.string(),
		url: z.string(),
		visitedAt: z.union([
			z.number(),
			z.literal(Number.POSITIVE_INFINITY),
			z.literal(Number.NEGATIVE_INFINITY),
		]),
	})
) satisfies z.ZodType<BrowserHistoryEntry>;
export const browserDownloadEntrySchema = preserveBrowserRecord(
	z.object({
		filename: z.string(),
		id: z.string(),
		path: z.string(),
		percent: z.number(),
		receivedBytes: z.number(),
		state: z.enum(["progressing", "completed", "cancelled", "interrupted"]),
		totalBytes: z.number(),
		updatedAt: z.number(),
		url: z.string(),
	})
) satisfies z.ZodType<BrowserDownloadEntry>;
/** Legacy profile rows validated only identity/location/state before display. */
export const browserStoredDownloadQuantitySchema = z.json().optional();
export type BrowserStoredDownloadQuantity = z.output<
	typeof browserStoredDownloadQuantitySchema
>;
export const browserLegacyDownloadEntrySchema = preserveBrowserRecord(
	z.object({
		filename: z.string(),
		id: z.string(),
		path: z.string(),
		url: z.string(),
		state: z.enum(["progressing", "completed", "cancelled", "interrupted"]),
		percent: browserStoredDownloadQuantitySchema,
		receivedBytes: browserStoredDownloadQuantitySchema,
		totalBytes: browserStoredDownloadQuantitySchema,
		updatedAt: browserStoredDownloadQuantitySchema,
	})
);
export type BrowserLegacyDownloadEntry = z.output<
	typeof browserLegacyDownloadEntrySchema
>;
export const browserDownloadRecordSchema = z.union([
	browserDownloadEntrySchema,
	browserLegacyDownloadEntrySchema,
]);
export const browserExtensionSchema = preserveBrowserRecord(
	z.object({ id: z.string(), name: z.string(), version: z.string() })
) satisfies z.ZodType<BrowserExtension>;
export const browserTabStateSchema = preserveBrowserRecord(
	z.object({
		canGoBack: z.boolean(),
		canGoForward: z.boolean(),
		id: z.string(),
		loading: z.boolean(),
		title: z.string(),
		url: z.string(),
		zoomPercent: z.number(),
	})
) satisfies z.ZodType<BrowserTabState>;
export const browserStateSchema = preserveBrowserRecord(
	z.object({
		activeId: z.string().nullable(),
		activeTitle: z.string(),
		activeUrl: z.string(),
		activities: z.array(browserActivitySchema),
		cdpRestartRequired: z.boolean(),
		deviceToolbar: z.boolean(),
		downloads: z.array(browserDownloadRecordSchema),
		extensions: z.array(browserExtensionSchema),
		history: z.array(browserHistoryEntrySchema),
		settings: browserSettingsSchema,
		surface: browserSurfaceSchema,
		tabs: z.array(browserTabStateSchema),
	})
) satisfies z.ZodType<BrowserState>;
export const browserFindResultSchema = preserveBrowserRecord(
	z.object({ activeMatchOrdinal: z.number(), matches: z.number() })
);
export const browserTabInfoSchema = preserveBrowserRecord(
	z.object({ id: z.string(), title: z.string(), url: z.string() })
);
const browserThemeRecordSchema = z.record(z.string(), z.string());
export const browserThemeSchema = preserveBrowserRecord(
	browserThemeRecordSchema
);
export const browserCookieTextSchema = z.string().optional().catch(undefined);
export type BrowserCookieText = z.output<typeof browserCookieTextSchema>;
export const browserSuggestedFilenameSchema = z
	.string()
	.optional()
	.catch(undefined);
export type BrowserSuggestedFilename = z.output<
	typeof browserSuggestedFilenameSchema
>;
export const browserPermissionCandidateSchema = z
	.string()
	.optional()
	.catch(undefined);
export type BrowserPermissionCandidate = z.output<
	typeof browserPermissionCandidateSchema
>;

/** Stored settings retain the existing per-field defaults and row filtering. */
export function browserStoredSettingsSchema(defaults: BrowserSettings) {
	return z
		.object({
			allowControl: z.boolean().catch(defaults.allowControl),
			annotationScreenshots: browserAnnotationPolicySchema.catch(
				defaults.annotationScreenshots
			),
			approval: browserApprovalSchema.catch(defaults.approval),
			askWhereToSave: z.boolean().catch(defaults.askWhereToSave),
			developerCdp: z.boolean().catch(defaults.developerCdp),
			downloadDirectory: z
				.string()
				.refine((value) => value.trim().length > 0)
				.catch(defaults.downloadDirectory),
			historyAccess: browserApprovalSchema.catch(defaults.historyAccess),
			localLinkDestination: browserLinkDestinationSchema.catch(
				defaults.localLinkDestination
			),
			sitePermissions: z
				.array(z.unknown())
				.catch(defaults.sitePermissions)
				.transform((items) =>
					items.flatMap((item) => {
						const result = browserSitePermissionSchema.safeParse(item);
						return result.success ? [result.data] : [];
					})
				),
			webLinkDestination: browserLinkDestinationSchema.catch(
				defaults.webLinkDestination
			),
		})
		.catch(defaults);
}

/** Profile settings are read from a JSON file before field-level default recovery. */
export const browserPersistedSettingsSchema = z.json().optional();
export type BrowserPersistedSettings = z.output<
	typeof browserPersistedSettingsSchema
>;

export const browserPersistedProfileSchema = z
	.object({
		settings: browserPersistedSettingsSchema,
		extensionPaths: z
			.array(z.unknown())
			.catch(() => [])
			.transform((values) =>
				values
					.flatMap((value) => {
						const parsed = z.string().safeParse(value);
						return parsed.success ? [parsed.data.trim()] : [];
					})
					.filter((path) => path.length > 0)
					.filter((path, index, paths) => paths.indexOf(path) === index)
					.slice(0, 24)
			),
		history: z
			.array(z.unknown())
			.catch(() => [])
			.transform((values) =>
				values
					.flatMap((value) => {
						const parsed = browserHistoryEntrySchema.safeParse(value);
						return parsed.success ? [parsed.data] : [];
					})
					.slice(0, 200)
			),
		downloads: z
			.array(z.unknown())
			.catch(() => [])
			.transform((values) =>
				values
					.flatMap((value) => {
						const parsed = browserLegacyDownloadEntrySchema.safeParse(value);
						return parsed.success ? [parsed.data] : [];
					})
					.slice(0, 100)
			),
	})
	.catch(() => ({ extensionPaths: [], history: [], downloads: [] }));
export const browserPersistedCdpSchema = z.object({
	settings: z.object({ developerCdp: z.literal(true) }),
});
