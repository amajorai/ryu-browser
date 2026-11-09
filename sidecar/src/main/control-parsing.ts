import { z } from "zod";
import type { LiveViewDeps } from "./control-live-view.ts";
import type { ProfileLanes } from "./control-profiles.ts";
import {
	type BrowserControlBody,
	type BrowserControlValue,
	type BrowserRawStyleInput,
	browserControlBodySchema,
	browserRawStyleInputSchema,
} from "./control-records.ts";
import type { BrowserRect, TabInfo, TabManager } from "./tab-manager.ts";
import type { VaultClient } from "./vault-fill.ts";
import { browserWebMCPJSONValueSchema } from "./webmcp-records.ts";

export interface ControlResponse {
	/** JSON body (serialized by the caller). Mutually exclusive with `raw`. */
	json?: unknown;
	/** Pre-serialized body + content type, for non-JSON payloads. */
	raw?: { body: string; contentType: string };
	status: number;
}

export const PACKAGE_VERSION = "1.0.0";

export function notFound(): ControlResponse {
	return { status: 404, json: { ok: false, error: "not found" } };
}

export function badRequest(error: string): ControlResponse {
	return { status: 400, json: { ok: false, error } };
}

export function unsupportedMediaType(): ControlResponse {
	return {
		status: 415,
		json: { ok: false, error: "application/json body required" },
	};
}

export function tabView(tab: TabInfo) {
	return { id: tab.id, url: tab.url, title: tab.title };
}

/** 404 for "the tab you asked for (or the only tab there could have been) is gone". */
export function noSuchTab(explicit: boolean): ControlResponse {
	return {
		status: 404,
		json: {
			ok: false,
			error: explicit
				? "no such tab"
				: "no open tab to act on — open one with POST /tabs first",
		},
	};
}

/** Upper bound on a caller-supplied scroll distance, in CSS pixels. */
export const MAX_SCROLL_AMOUNT = 100_000;
export const MAX_COORDINATE_COUNT = 8;
export const THEME_TOKEN_NAME_RE = /^--[a-zA-Z0-9_-]{1,100}$/;
export const THEME_TOKEN_VALUE_UNSAFE_RE = /[{}<>;]/;
export const MAX_THEME_TOKEN_COUNT = 128;
export const MAX_THEME_TOKEN_VALUE_LENGTH = 16_384;

export function parseJsonBody(raw: string): BrowserControlBody | null {
	if (!raw) {
		return {};
	}
	try {
		const parsed = browserControlBodySchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function parseThemeTokens(body: string): Record<string, string> | null {
	const parsed = parseJsonBody(body);
	const parsedTokens = browserControlBodySchema.safeParse(parsed?.tokens);
	if (!parsedTokens.success) {
		return null;
	}
	const entries = Object.entries(parsedTokens.data);
	if (entries.length > MAX_THEME_TOKEN_COUNT) {
		return null;
	}
	const tokens: Record<string, string> = {};
	for (const [name, value] of entries) {
		const parsedValue = z.string().safeParse(value);
		if (
			!(THEME_TOKEN_NAME_RE.test(name) && parsedValue.success) ||
			parsedValue.data.length === 0 ||
			parsedValue.data.length > MAX_THEME_TOKEN_VALUE_LENGTH ||
			THEME_TOKEN_VALUE_UNSAFE_RE.test(parsedValue.data)
		) {
			// Match the shared host bridge: one invalid optional token (for
			// example a page-background URL with CSS punctuation) must not
			// discard the complete appearance snapshot.
			continue;
		}
		tokens[name] = parsedValue.data;
	}
	return tokens;
}

export function parseRect(value: BrowserControlValue): BrowserRect | null {
	const parsed = browserControlBodySchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const rect = parsed.data;
	const x = Number(rect.x);
	const y = Number(rect.y);
	const width = Number(rect.width ?? 0);
	const height = Number(rect.height ?? 0);
	if (
		![x, y, width, height].every(Number.isFinite) ||
		width < 0 ||
		height < 0 ||
		width > 100_000 ||
		height > 100_000
	) {
		return null;
	}
	return { height, width, x, y };
}

export function parseSelections(
	value: BrowserControlValue
): BrowserRect[] | null {
	if (value === undefined) {
		return [];
	}
	const parsed = z.array(browserWebMCPJSONValueSchema).safeParse(value);
	if (!parsed.success || parsed.data.length > MAX_COORDINATE_COUNT) {
		return null;
	}
	const selections: BrowserRect[] = [];
	for (const item of parsed.data) {
		const rect = parseRect(item);
		if (!rect) {
			return null;
		}
		selections.push(rect);
	}
	return selections;
}

export function parseStyle(
	value: BrowserControlValue
): BrowserRawStyleInput | undefined {
	const parsed = browserRawStyleInputSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

export interface RequestDeps {
	controlEnabled?: () => boolean;
	/** The owner's read-only view of Bot lanes; absent when there are none. */
	liveView?: LiveViewDeps;
	/** The Bot lanes for the profile and session routes; null until they exist. */
	profileLanes?: () => ProfileLanes | null;
	setTheme?: (tokens: Record<string, string>) => void;
	tabs: TabManager;
	/**
	 * A managed Bot's own tab lane; may resolve once its isolated session is
	 * ready. `egressAllowlist` is Core's raw allowlist header for the lane.
	 */
	tabsFor?: (
		agentId: string,
		egressAllowlist?: string
	) => TabManager | null | Promise<TabManager | null>;
	token: string | null;
	validateNavigationUrl?: (value: string) => Promise<string> | string;
	/** Core's `vault.*` kernel capabilities; null/absent outside Core (503). */
	vault?: VaultClient | null;
}

/** Who is asking for an agent-account credential, and how to reach the vault. */
export interface CredentialContext {
	/** Core-verified calling agent (the stamped lane), or undefined for the user lane. */
	agentId: string | undefined;
	/** The agent lane's own browser session id (`lane-session.ts`), never the caller's. */
	browserSession?: string;
	vault: VaultClient | null;
}
