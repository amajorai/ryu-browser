import {
	badRequest,
	type ControlResponse,
	type CredentialContext,
	noSuchTab,
	tabView,
} from "./control-parsing.ts";
import {
	type BrowserControlBody,
	browserControlString,
} from "./control-records.ts";
import type { TabManager } from "./tab-manager.ts";
import {
	credentialFieldSchema,
	extractTotpSecret,
	MAX_ACCOUNT_ID_LENGTH,
	TOTP_NOT_FOUND_MESSAGE,
} from "./vault-fill.ts";

export function vaultUnavailable(): ControlResponse {
	return {
		status: 503,
		json: {
			ok: false,
			error:
				"agent accounts need the Ryu vault, and this browser was not started by Ryu Core",
		},
	};
}

/** Handle prefix of a user item attached to the agent's browser session. */
export const ATTACHED_HANDLE_PREFIX = "attached:";

/**
 * The browser session to report with a fill. Only an attached item's fill
 * carries it: Core pins the attached set to it. An agent's own account keeps
 * the original wire shape, so a Core without fill sets still fills it.
 */
export function fillBrowserSession(
	account: string,
	browserSession: string | undefined
): { browser_session?: string } {
	return account.startsWith(ATTACHED_HANDLE_PREFIX) && browserSession
		? { browser_session: browserSession }
		: {};
}

export function parseAccountId(parsed: BrowserControlBody): string | null {
	const account = (browserControlString(parsed.account) ?? "").trim();
	return account && account.length <= MAX_ACCOUNT_ID_LENGTH ? account : null;
}

/**
 * Fill an agent-account credential. The response deliberately carries no value:
 * the secret goes from Core to the page's editing pipeline and nowhere else.
 */
export async function runFillCredential(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody,
	{ agentId, browserSession, vault }: CredentialContext
): Promise<ControlResponse> {
	const ref = (browserControlString(parsed.ref) ?? "").trim();
	if (ref === "") {
		return badRequest("missing ref");
	}
	const account = parseAccountId(parsed);
	if (!account) {
		return badRequest(
			"missing account: pass an id or an attached item's handle from chromium.list_accounts"
		);
	}
	const field = credentialFieldSchema.safeParse(parsed.field);
	if (!field.success) {
		return badRequest("field must be one of username, email, password, totp");
	}
	if (!vault) {
		return vaultUnavailable();
	}
	const result = await tabs.fillCredential(
		tabId,
		ref,
		field.data,
		(pageUrl) =>
			vault.credentialFill({
				account,
				agent_id: agentId ?? null,
				...fillBrowserSession(account, browserSession),
				field: field.data,
				page_url: pageUrl,
			}),
		parsed.submit === true
	);
	return result === null
		? noSuchTab(true)
		: {
				status: 200,
				json: {
					ok: true,
					tab: tabView(result.tab),
					account,
					field: field.data,
					filled: true,
				},
			};
}

/**
 * Read a 2FA setup QR code or text key from the page and enroll it in the vault.
 * The secret is never returned, so the agent can only USE it via
 * `/fill-credential` with field `totp`.
 */
export async function runCaptureTotp(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody,
	{ agentId, vault }: CredentialContext
): Promise<ControlResponse> {
	const ref = (browserControlString(parsed.ref) ?? "").trim();
	if (ref === "") {
		return badRequest("missing ref");
	}
	const account = parseAccountId(parsed);
	if (!account) {
		return badRequest(
			"missing account: pass the id from chromium.create_account or chromium.list_accounts"
		);
	}
	if (!vault) {
		return vaultUnavailable();
	}
	const source = await tabs.readTotpSetup(tabId, ref);
	if (source === null) {
		return noSuchTab(true);
	}
	if (source.in_frame) {
		return badRequest(
			"the setup key is inside an iframe; only the page's top-level document can enroll a TOTP secret"
		);
	}
	const secret = extractTotpSecret(source.candidates);
	if (!secret) {
		return badRequest(TOTP_NOT_FOUND_MESSAGE);
	}
	await vault.totpEnroll({
		account,
		agent_id: agentId ?? null,
		page_url: source.tab.url,
		secret,
	});
	return {
		status: 200,
		json: { ok: true, tab: tabView(source.tab), account, enrolled: true },
	};
}
