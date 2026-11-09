/**
 * English source for Ryu Browser's OS-rendered bundle strings: the text macOS
 * reads from `Info.plist` outside the shell renderer (and its i18n runtime).
 * Today those are the camera and microphone permission prompts macOS shows
 * the first time a website the user allowed asks for either device.
 *
 * `scripts/sync-browser-infoplist-strings.mjs` turns this table plus
 * `packages/i18n/locales/<locale>.json` into
 * `apps-store/browser/sidecar/resources/locales/<lproj>.lproj/InfoPlist.strings`,
 * which `electron-builder.yml` copies into the app bundle through
 * `mac.extraResources`. Its `--check` fails when a generated file, the
 * `mac.extendInfo` English value or the copy list drifts.
 *
 * - The key is the `Info.plist` key; the value is its exact English text, which
 *   must also be the `mac.extendInfo` value in `electron-builder.yml`.
 * - Values are plain sentences: no placeholders, no ICU plurals or selects.
 * - Keep one string literal per key, passed straight to the translator: the
 *   generator and `tools/i18n-extract` read each literal from the source.
 *   Nothing in the app imports this module; the default translator returns
 *   the English source. It lives under `src/renderer/` (like Island's
 *   `renderer/lib/native-bundle-copy.ts`) because that is the Browser sidecar
 *   path the extractor scans for shell copy.
 */

export type BundleTranslator = (source: string) => string;

const english: BundleTranslator = (source) => source;

/** The bundle strings, each passed through `tl` (English by default). */
export function nativeBundleCopy(tl: BundleTranslator = english) {
	return {
		NSCameraUsageDescription: tl(
			"Ryu Browser lets websites you allow use the camera."
		),
		NSMicrophoneUsageDescription: tl(
			"Ryu Browser lets websites you allow use the microphone."
		),
	} as const;
}

export type NativeBundleCopyKey = keyof ReturnType<typeof nativeBundleCopy>;
