import { z } from "zod";

const cookieImportResult = z.object({
	imported: z.number(),
	message: z.string().optional(),
});
export const browserCookieImportResultSchema = z.custom<
	z.output<typeof cookieImportResult>
>((value) => cookieImportResult.safeParse(value).success);
const screenshotResult = z.object({
	saved: z.boolean(),
	path: z.string().optional(),
});
export const browserScreenshotResultSchema = z.custom<
	z.output<typeof screenshotResult>
>((value) => screenshotResult.safeParse(value).success);
