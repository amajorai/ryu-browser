import { describe, expect, test } from "bun:test";
import {
	type ApplicationMenuHost,
	removeDefaultApplicationMenu,
	shouldRemoveDefaultMenu,
} from "./native-menu.ts";

function fakeMenu(): ApplicationMenuHost & { calls: null[] } {
	const calls: null[] = [];
	return {
		calls,
		setApplicationMenu(menu) {
			calls.push(menu);
		},
	};
}

describe("removeDefaultApplicationMenu", () => {
	test("clears the default menu on Windows and Linux", () => {
		for (const platform of ["win32", "linux"] as const) {
			const menu = fakeMenu();
			expect(removeDefaultApplicationMenu(menu, platform)).toBe(true);
			expect(menu.calls).toEqual([null]);
		}
	});

	test("keeps the macOS menu so its Edit roles still route shortcuts", () => {
		const menu = fakeMenu();
		expect(removeDefaultApplicationMenu(menu, "darwin")).toBe(false);
		expect(menu.calls).toEqual([]);
		expect(shouldRemoveDefaultMenu("darwin")).toBe(false);
	});
});
