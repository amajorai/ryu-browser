import { afterEach, describe, expect, it } from "bun:test";
import catalogs from "../i18n/shell-catalog.generated.json";
import { setShellLocale, tl } from "../i18n/shell-i18n.ts";
import { safeNavigationUrl } from "../main/control.ts";
import { codedNavigationError, shellError } from "../main/shell-error.ts";
import { LocalizedError, toastMessageFor } from "./ipc-error.ts";

const CATALOGS: Record<string, Record<string, string>> = catalogs;

/** What `ipcRenderer.invoke` rejects with when the main handler throws `error`. */
function ipcRejection(channel: string, error: Error): Error {
	return new Error(
		`Error invoking remote method '${channel}': ${String(error)}`
	);
}

afterEach(() => {
	setShellLocale("en");
});

describe("shell toast messages for failed bridge calls", () => {
	it("shows the localized fallback, not Electron's English rejection, under de", () => {
		setShellLocale("de");
		const rejection = ipcRejection(
			"ryu-browser:choose-extension-directory",
			new Error(
				"Loading extension at /Users/me/foo failed with: Manifest file is missing or unreadable"
			)
		);
		const message = toastMessageFor(
			rejection,
			tl("Unable to load this extension")
		);
		expect(message).toBe(CATALOGS.de?.["Unable to load this extension"] ?? "");
		expect(message).not.toContain("Error invoking remote method");
		expect(message).not.toBe("Unable to load this extension");
	});

	it("maps a coded main-side error to its localized sentence", () => {
		setShellLocale("de");
		const rejection = ipcRejection(
			"ryu-browser:navigate",
			shellError("url-required", "Enter a URL")
		);
		expect(toastMessageFor(rejection, tl("Unable to navigate"))).toBe(
			CATALOGS.de?.["Enter a URL"] ?? ""
		);
		expect(
			toastMessageFor(
				shellError(
					"extension-folder-required",
					"Choose an unpacked extension folder"
				),
				"fallback"
			)
		).toBe(CATALOGS.de?.["Choose an unpacked extension folder"] ?? "");
	});

	it("keeps a renderer-thrown localized message and falls back for anything else", () => {
		expect(toastMessageFor(new LocalizedError("Bereits übersetzt"), "x")).toBe(
			"Bereits übersetzt"
		);
		expect(toastMessageFor("not an error", "Fallback")).toBe("Fallback");
		expect(toastMessageFor(new TypeError("Invalid URL"), "Fallback")).toBe(
			"Fallback"
		);
		expect(
			toastMessageFor(
				shellError("navigation-private-host", "blocked"),
				"Fallback"
			)
		).toBe("Ryu Browser can't open private or local network addresses.");
	});

	it("traces a guard refusal and an empty URL to ja and ar toasts", () => {
		let refusal: unknown;
		try {
			safeNavigationUrl("http://localhost:3000");
		} catch (error) {
			refusal = codedNavigationError(error);
		}
		const privateHost = ipcRejection("ryu-browser:navigate", refusal as Error);
		const empty = ipcRejection(
			"ryu-browser:navigate",
			shellError("url-required", "Enter a URL")
		);
		for (const locale of ["ja", "ar"]) {
			setShellLocale(locale);
			const fallback = tl("Unable to load this extension");
			expect(fallback).not.toBe("Unable to load this extension");
			expect(toastMessageFor(empty, fallback)).toBe(
				CATALOGS[locale]?.["Enter a URL"] ?? ""
			);
			expect(toastMessageFor(empty, fallback)).not.toBe("Enter a URL");
			const privateToast = toastMessageFor(privateHost, fallback);
			expect(privateToast).toBe(
				tl("Ryu Browser can't open private or local network addresses.")
			);
			expect(privateToast).not.toContain("browser navigation");
		}
	});
});
