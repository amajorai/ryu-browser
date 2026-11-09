import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { nativeBundleCopy } from "./native-bundle-copy.ts";

const CAMERA = "Ryu Browser lets websites you allow use the camera.";
const MICROPHONE = "Ryu Browser lets websites you allow use the microphone.";

/** Stub catalogs: the shipped translations do not exist yet. */
const STUB_CATALOGS: Record<string, Record<string, string>> = {
	ja: {
		[CAMERA]:
			"Ryu Browser は、許可したウェブサイトにカメラの使用を許可します。",
		[MICROPHONE]:
			"Ryu Browser は、許可したウェブサイトにマイクの使用を許可します。",
	},
	ar: {
		[CAMERA]: "يتيح Ryu Browser للمواقع التي تسمح لها باستخدام الكاميرا.",
		[MICROPHONE]: "يتيح Ryu Browser للمواقع التي تسمح لها باستخدام الميكروفون.",
	},
	de: {
		[CAMERA]: "Ryu Browser lässt Websites, die du erlaubst, die Kamera nutzen.",
		[MICROPHONE]:
			"Ryu Browser lässt Websites, die du erlaubst, das Mikrofon nutzen.",
	},
};

function translatorFor(locale: string) {
	const catalog = STUB_CATALOGS[locale] ?? {};
	return (source: string) => catalog[source] ?? source;
}

describe("nativeBundleCopy", () => {
	it("defaults to the English purpose strings", () => {
		expect(nativeBundleCopy()).toEqual({
			NSCameraUsageDescription: CAMERA,
			NSMicrophoneUsageDescription: MICROPHONE,
		});
	});

	for (const locale of ["ja", "ar", "de"]) {
		it(`passes both sentences through the ${locale} translator`, () => {
			const copy = nativeBundleCopy(translatorFor(locale));
			expect(copy.NSCameraUsageDescription).toBe(
				STUB_CATALOGS[locale]?.[CAMERA] ?? ""
			);
			expect(copy.NSMicrophoneUsageDescription).toBe(
				STUB_CATALOGS[locale]?.[MICROPHONE] ?? ""
			);
			for (const value of Object.values(copy)) {
				expect(value).not.toContain("websites you allow");
			}
		});
	}

	it("keeps each sentence a literal tl() call the generator can read", () => {
		const source = readFileSync(
			new URL("./native-bundle-copy.ts", import.meta.url),
			"utf8"
		);
		const entries = [
			...source.matchAll(/(\w+):\s*tl\(\s*("(?:[^"\\]|\\.)*")\s*,?\s*\)/gu),
		].map(([, key, literal]) => [key, JSON.parse(literal ?? '""')]);
		expect(Object.fromEntries(entries)).toEqual(nativeBundleCopy());
	});
});
