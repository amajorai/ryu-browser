/**
 * Copy the main process shows in native dialogs and returns to the shell
 * renderer, in the shell locale (see `../i18n/shell-i18n.ts`). Every string
 * goes through a literal `tl()` call so the extractor catalogs it and
 * `scripts/sync-browser-shell-catalog.mjs` ships its translations.
 */
import { tl } from "../i18n/shell-i18n.ts";
import type { BrowserPermission } from "./browser-state.ts";

function singlePermissionDetail(
	origin: string,
	permission: BrowserPermission
): string {
	switch (permission) {
		case "camera":
			return tl("{origin} requested access to camera.", { origin });
		case "microphone":
			return tl("{origin} requested access to microphone.", { origin });
		case "geolocation":
			return tl("{origin} requested access to geolocation.", { origin });
		case "notifications":
			return tl("{origin} requested access to notifications.", { origin });
		case "clipboard-read":
			return tl("{origin} requested access to clipboard-read.", { origin });
	}
	const _exhaustive: never = permission;
	return _exhaustive;
}

function permissionDetail(
	origin: string,
	permissions: readonly BrowserPermission[]
): string {
	const [first] = permissions;
	if (permissions.length === 1 && first) {
		return singlePermissionDetail(origin, first);
	}
	if (
		permissions.length === 2 &&
		permissions.includes("camera") &&
		permissions.includes("microphone")
	) {
		return tl("{origin} requested access to camera and microphone.", {
			origin,
		});
	}
	return tl("{origin} requested access to {permissions}.", {
		origin,
		permissions: permissions.join(", "),
	});
}

/** The site-permission prompt (`dialog.showMessageBox`). */
export function permissionPromptCopy(
	origin: string,
	permissions: readonly BrowserPermission[]
): {
	buttons: string[];
	detail: string;
	message: string;
	title: string;
} {
	return {
		buttons: [tl("Allow"), tl("Block")],
		detail: permissionDetail(origin, permissions),
		message: tl("Allow this site permission?"),
		title: tl("Ryu Browser permission"),
	};
}

/** The "ask where to save" download dialog. */
export function downloadSaveDialogCopy(): {
	buttonLabel: string;
	nameFieldLabel: string;
} {
	return {
		buttonLabel: tl("Save"),
		nameFieldLabel: tl("Save download as"),
	};
}

/** The page screenshot save dialog. */
export function screenshotSaveDialogCopy(): {
	buttonLabel: string;
	filterName: string;
} {
	return {
		buttonLabel: tl("Save screenshot"),
		filterName: tl("PNG image"),
	};
}

/** The cookie import file picker. */
export function cookieImportDialogCopy(): {
	filterName: string;
	title: string;
} {
	return {
		filterName: tl("Browser export"),
		title: tl("Import cookies"),
	};
}

/** The outcome of a cookie import, shown as a toast in the shell. */
export const cookieImportMessages = {
	cancelled: () => tl("Import cancelled"),
	imported: (count: number) =>
		count > 0
			? tl(
					"{count, plural, one {# cookie imported. Passwords remain protected by the OS password manager.} other {# cookies imported. Passwords remain protected by the OS password manager.}}",
					{ count }
				)
			: tl("No compatible cookies found in that export."),
	unreadable: () => tl("That browser export could not be read."),
	unavailable: () => tl("Browser sidecar unavailable"),
};

/** Title of the download-location folder picker. */
export function downloadDirectoryDialogTitle(): string {
	return tl("Choose download location");
}

/** Title of the unpacked-extension folder picker. */
export function extensionDirectoryDialogTitle(): string {
	return tl("Load unpacked Chromium extension");
}
