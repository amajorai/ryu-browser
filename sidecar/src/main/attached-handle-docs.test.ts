import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ATTACHED_HANDLE_PREFIX } from "./control-credentials.ts";

// Core numbers an attached item's handle from 1 (`attached:1` is the first
// item the user attached). A documented `attached:0` names no item, and an
// agent copying it gets a refusal, so every example must start at 1.
const FIRST_CORE_HANDLE = 1;

function documentedHandles(path: string): number[] {
	const text = readFileSync(new URL(path, import.meta.url), "utf8");
	const pattern = new RegExp(`${ATTACHED_HANDLE_PREFIX}(\\d+)`, "g");
	return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}

describe("documented attached-item handles", () => {
	for (const path of [
		"../../../manifest.json",
		"../../../manifest-src/runnables/accounts.json",
	]) {
		it(`numbers handles from Core's first handle in ${path}`, () => {
			const handles = documentedHandles(path);
			expect(handles.length).toBeGreaterThan(0);
			for (const handle of handles) {
				expect(handle).toBeGreaterThanOrEqual(FIRST_CORE_HANDLE);
			}
		});
	}
});
