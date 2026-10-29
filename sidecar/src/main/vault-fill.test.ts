import { describe, expect, it } from "bun:test";
import { RefError } from "./tab-manager.ts";
import {
	type CredentialTargetProbe,
	createVaultClient,
	credentialTargetRefusal,
	extractTotpSecret,
	performCredentialFill,
	VaultFillError,
	vaultClientFromEnv,
} from "./vault-fill.ts";

const PASSWORD_INPUT: CredentialTargetProbe = {
	editable: true,
	focused: true,
	in_frame: false,
	input_type: "password",
	tag: "INPUT",
};
const TEXT_INPUT: CredentialTargetProbe = {
	...PASSWORD_INPUT,
	input_type: "text",
};
const SECRET = "Zq9!secret-PASSWORD-never-echoed";

describe("credentialTargetRefusal", () => {
	it("accepts a password input for a password and any text input otherwise", () => {
		expect(credentialTargetRefusal(PASSWORD_INPUT, "password")).toBeNull();
		expect(credentialTargetRefusal(TEXT_INPUT, "username")).toBeNull();
		expect(
			credentialTargetRefusal({ ...TEXT_INPUT, input_type: "email" }, "email")
		).toBeNull();
		expect(
			credentialTargetRefusal({ ...TEXT_INPUT, input_type: "tel" }, "totp")
		).toBeNull();
	});

	it("only fills a password into <input type=password>", () => {
		expect(credentialTargetRefusal(TEXT_INPUT, "password")).toContain(
			"type=password"
		);
		expect(
			credentialTargetRefusal(
				{ editable: true, focused: true, in_frame: false, tag: "TEXTAREA" },
				"password"
			)
		).toContain("type=password");
		expect(
			credentialTargetRefusal(
				{ editable: true, focused: true, in_frame: false, tag: "DIV" },
				"password"
			)
		).toContain("type=password");
	});

	it("refuses frames, moved focus, and fields that cannot take text", () => {
		expect(
			credentialTargetRefusal({ ...PASSWORD_INPUT, in_frame: true }, "password")
		).toContain("iframe");
		expect(
			credentialTargetRefusal(
				{ editable: false, focused: true, in_frame: true, tag: "IFRAME" },
				"username"
			)
		).toContain("iframe");
		expect(
			credentialTargetRefusal({ ...TEXT_INPUT, focused: false }, "username")
		).toContain("did not take focus");
		expect(
			credentialTargetRefusal({ ...TEXT_INPUT, disabled: true }, "username")
		).toContain("disabled");
		expect(
			credentialTargetRefusal({ ...TEXT_INPUT, read_only: true }, "username")
		).toContain("read-only");
		expect(
			credentialTargetRefusal(
				{ ...TEXT_INPUT, input_type: "checkbox" },
				"username"
			)
		).toContain("checkbox");
		expect(
			credentialTargetRefusal(
				{ editable: false, focused: true, in_frame: false, tag: "A" },
				"username"
			)
		).toContain("cannot accept text");
	});
});

describe("performCredentialFill", () => {
	it("checks the target before asking for the value and inserts it once", async () => {
		const order: string[] = [];
		const inserted: string[] = [];
		await performCredentialFill(
			{
				insert: async (value) => {
					order.push("insert");
					inserted.push(value);
				},
				pageUrl: () => "https://github.com/login",
				probe: async () => {
					order.push("probe");
					return PASSWORD_INPUT;
				},
			},
			"password",
			async (pageUrl) => {
				order.push(`resolve ${pageUrl}`);
				return SECRET;
			}
		);
		expect(order).toEqual([
			"probe",
			"resolve https://github.com/login",
			"probe",
			"insert",
		]);
		expect(inserted).toEqual([SECRET]);
	});

	it("never requests the value for a refused target", async () => {
		let resolved = false;
		const attempt = performCredentialFill(
			{
				insert: async () => undefined,
				pageUrl: () => "https://github.com/login",
				probe: async () => TEXT_INPUT,
			},
			"password",
			async () => {
				resolved = true;
				return SECRET;
			}
		);
		await expect(attempt).rejects.toBeInstanceOf(RefError);
		expect(resolved).toBe(false);
	});

	it("drops the value when the page navigated meanwhile, without naming it", async () => {
		let url = "https://github.com/login";
		const error = await performCredentialFill(
			{
				insert: async () => {
					throw new Error("must not insert");
				},
				pageUrl: () => url,
				probe: async () => PASSWORD_INPUT,
			},
			"password",
			async () => {
				url = "https://evil.example/";
				return SECRET;
			}
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RefError);
		expect(String(error)).not.toContain(SECRET);
	});

	it("treats an empty stored value as missing", async () => {
		const error = await performCredentialFill(
			{
				insert: async () => undefined,
				pageUrl: () => "https://github.com/login",
				probe: async () => TEXT_INPUT,
			},
			"totp",
			async () => ""
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VaultFillError);
		expect((error as VaultFillError).status).toBe(404);
	});
});

describe("extractTotpSecret", () => {
	it("returns an otpauth URI as-is, preferring earlier candidates", () => {
		const uri =
			"otpauth://totp/GitHub:ryu-bot?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
		expect(extractTotpSecret([uri, "ABCDEFGHIJKLMNOP"])).toBe(uri);
		expect(extractTotpSecret([`<a href="${uri}">open</a>`])).toBe(uri);
		expect(extractTotpSecret([null, "", `Link: ${uri}`])).toBe(uri);
	});

	it("normalizes spaced, dashed, and lower-case Base32 keys", () => {
		expect(extractTotpSecret(["JBSW Y3DP EHPK 3PXP"])).toBe("JBSWY3DPEHPK3PXP");
		expect(extractTotpSecret(["jbsw-y3dp-ehpk-3pxp"])).toBe("JBSWY3DPEHPK3PXP");
		expect(extractTotpSecret(["Your setup key: jbsw y3dp ehpk 3pxp"])).toBe(
			"JBSWY3DPEHPK3PXP"
		);
		expect(
			extractTotpSecret(["Setup key\nKEY JBSW Y3DP EHPK 3PXP\nDone"])
		).toBe("JBSWY3DPEHPK3PXP");
		expect(extractTotpSecret(["ABCD EFGH IJKL MNOP"])).toBe("ABCDEFGHIJKLMNOP");
		expect(
			extractTotpSecret(["Use this code: JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP."])
		).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
	});

	it("rejects garbage, prose, and keys of the wrong size", () => {
		expect(extractTotpSecret([])).toBeNull();
		expect(extractTotpSecret(["Scan this QR code with your app"])).toBeNull();
		expect(extractTotpSecret(["ENTER THIS KEY MANUALLY"])).toBeNull();
		expect(extractTotpSecret(["internationalization settings"])).toBeNull();
		expect(extractTotpSecret(["JBSW Y3DP"])).toBeNull(); // too short
		expect(extractTotpSecret(["0189 0189 0189 0189"])).toBeNull(); // not Base32
		expect(extractTotpSecret([`${"A2".repeat(65)}`])).toBeNull(); // too long
		expect(extractTotpSecret(["otpauth://hotp/x?secret=ABC"])).toBeNull();
	});
});

describe("createVaultClient", () => {
	interface Captured {
		body: unknown;
		headers: Headers;
		init: RequestInit | undefined;
		url: string;
	}

	function fakeFetch(
		response: () => Response,
		captured: Captured[]
	): typeof fetch {
		const impl = async (
			input: RequestInfo | URL,
			init?: RequestInit
		): Promise<Response> => {
			captured.push({
				body: JSON.parse(String(init?.body)),
				headers: new Headers(init?.headers),
				init,
				url: String(input),
			});
			return response();
		};
		return impl as typeof fetch;
	}

	it("calls Core's kernel capability with the sidecar credential", async () => {
		const captured: Captured[] = [];
		const client = createVaultClient({
			corePort: 8980,
			fetchImpl: fakeFetch(
				() => Response.json({ account: "a", field: "password", value: SECRET }),
				captured
			),
			pluginId: "@ryu/browser",
			token: "ext-token",
		});
		const value = await client.credentialFill({
			account: "github.com--a1b2c3d4",
			agent_id: "agent-7",
			field: "password",
			page_url: "https://github.com/login",
		});
		expect(value).toBe(SECRET);
		expect(captured[0]?.url).toBe(
			"http://127.0.0.1:8980/api/host/capability/vault.credentialFill"
		);
		expect(captured[0]?.init?.redirect).toBe("error");
		expect(captured[0]?.headers.get("authorization")).toBe("Bearer ext-token");
		expect(captured[0]?.headers.get("x-ryu-plugin-id")).toBe("@ryu/browser");
		expect(captured[0]?.body).toEqual({
			account: "github.com--a1b2c3d4",
			agent_id: "agent-7",
			field: "password",
			page_url: "https://github.com/login",
		});

		await client.totpEnroll({
			account: "github.com--a1b2c3d4",
			agent_id: null,
			page_url: "https://github.com/settings",
			secret: "JBSWY3DPEHPK3PXP",
		});
		expect(captured[1]?.url).toEndWith("/api/host/capability/vault.totpEnroll");
	});

	it("surfaces Core's {error} with a mapped status", async () => {
		const forbidden = createVaultClient({
			corePort: 8980,
			fetchImpl: fakeFetch(
				() =>
					Response.json(
						{ error: "page host evil.example does not match github.com" },
						{ status: 403 }
					),
				[]
			),
			pluginId: "@ryu/browser",
			token: "ext-token",
		});
		const error = await forbidden
			.credentialFill({
				account: "github.com--a1b2c3d4",
				agent_id: null,
				field: "password",
				page_url: "https://evil.example/",
			})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VaultFillError);
		expect((error as VaultFillError).status).toBe(403);
		expect((error as VaultFillError).message).toContain(
			"does not match github.com"
		);

		const broken = createVaultClient({
			corePort: 8980,
			fetchImpl: fakeFetch(() => new Response("oops", { status: 500 }), []),
			pluginId: "@ryu/browser",
			token: "ext-token",
		});
		const failure = await broken
			.totpEnroll({
				account: "a",
				agent_id: null,
				page_url: "https://github.com/",
				secret: "JBSWY3DPEHPK3PXP",
			})
			.catch((e: unknown) => e);
		expect((failure as VaultFillError).status).toBe(502);
		expect(String(failure)).not.toContain("JBSWY3DPEHPK3PXP");
	});

	it("reports an unreachable Core and a malformed reply", async () => {
		const offline = createVaultClient({
			corePort: 8980,
			fetchImpl: (async () => {
				throw new TypeError("connect ECONNREFUSED");
			}) as unknown as typeof fetch,
			pluginId: "@ryu/browser",
			token: "ext-token",
		});
		const error = await offline
			.credentialFill({
				account: "a",
				agent_id: null,
				field: "username",
				page_url: "https://github.com/",
			})
			.catch((e: unknown) => e);
		expect((error as VaultFillError).status).toBe(502);

		const malformed = createVaultClient({
			corePort: 8980,
			fetchImpl: fakeFetch(() => Response.json({ nope: true }), []),
			pluginId: "@ryu/browser",
			token: "ext-token",
		});
		const bad = await malformed
			.credentialFill({
				account: "a",
				agent_id: null,
				field: "username",
				page_url: "https://github.com/",
			})
			.catch((e: unknown) => e);
		expect((bad as VaultFillError).status).toBe(502);
	});
});

describe("vaultClientFromEnv", () => {
	it("needs Core's port and the minted app token", () => {
		expect(vaultClientFromEnv({})).toBeNull();
		expect(vaultClientFromEnv({ RYU_CORE_PORT: "8980" })).toBeNull();
		expect(
			vaultClientFromEnv({ RYU_CORE_PORT: "nope", RYU_EXT_TOKEN: "t" })
		).toBeNull();
		expect(
			vaultClientFromEnv({ RYU_CORE_PORT: "8980", RYU_EXT_TOKEN: "t" })
		).not.toBeNull();
	});
});
