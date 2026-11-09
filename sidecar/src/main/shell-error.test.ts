import { describe, expect, it } from "bun:test";
import { safeNavigationUrl } from "./control.ts";
import {
	codedNavigationError,
	shellError,
	shellErrorCode,
} from "./shell-error.ts";

function refusal(value: string): unknown {
	try {
		safeNavigationUrl(value);
	} catch (error) {
		return error;
	}
	throw new Error(`expected ${value} to be refused`);
}

describe("coded shell errors", () => {
	it("keeps the English message and carries the code through String()", () => {
		const error = shellError("url-required", "Enter a URL");
		expect(error.message).toBe("Enter a URL");
		expect(String(error)).toContain("RyuBrowserError:url-required");
		expect(shellErrorCode(new Error(`wrapped: ${String(error)}`))).toBe(
			"url-required"
		);
	});

	it("ignores unknown codes and non-errors", () => {
		expect(shellErrorCode(new Error("RyuBrowserError:not-a-code"))).toBeNull();
		expect(shellErrorCode("RyuBrowserError:url-required")).toBeNull();
	});

	it("tags the navigation guard's refusals and passes other errors through", () => {
		const privateHost = codedNavigationError(refusal("http://localhost:3000"));
		expect(shellErrorCode(privateHost)).toBe("navigation-private-host");
		expect((privateHost as Error).message).toBe(
			"browser navigation cannot target private or local hosts"
		);
		expect(
			shellErrorCode(codedNavigationError(refusal("ftp://example.com")))
		).toBe("navigation-unsupported-url");
		const other = new Error("DNS lookup failed");
		expect(codedNavigationError(other)).toBe(other);
	});
});
