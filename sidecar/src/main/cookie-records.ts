import { z } from "zod";
import { browserAXPrimitiveNumberSchema } from "./ax-records.ts";

/** Chrome and common cookie exporters use either a root list or a cookies envelope. */
export const browserCookieExportSchema = z.union([
	z.array(z.unknown()),
	z.object({ cookies: z.array(z.unknown()) }),
]);
export const browserImportedCookieSchema = z.object({
	name: z.string().catch(""),
	value: z.string().catch(""),
	domain: z.string().catch(""),
	path: z
		.string()
		.catch("/")
		.transform((value) => (value.startsWith("/") ? value : "/")),
	url: z.string().optional().catch(undefined),
	expirationDate: browserAXPrimitiveNumberSchema.optional().catch(undefined),
	httpOnly: z
		.json()
		.optional()
		.transform((value) => value === true),
	secure: z
		.json()
		.optional()
		.transform((value) => value === true),
	sameSite: z
		.enum(["strict", "lax", "no_restriction", "unspecified"])
		.catch("unspecified"),
});
