/**
 * Byte sizes and relative times for the browser shell. English keeps the
 * shell's original wording exactly ("1.2 MB", "5 min ago", "Just now"); other
 * locales use `Intl` unit and relative-time formatting.
 */
import { shellLocale } from "./shell-i18n.ts";

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
const ENGLISH_BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function isEnglish(locale: string): boolean {
	return /^en(?:-|$)/iu.test(locale);
}

/** `bytes` (finite and positive, else zero) as B/KB/MB/GB in `locale`. */
export function formatByteCount(
	bytes: number,
	locale: string = shellLocale()
): string {
	const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
	const index =
		size === 0
			? 0
			: Math.min(
					BYTE_UNITS.length - 1,
					Math.floor(Math.log(size) / Math.log(1024))
				);
	const value = size / 1024 ** index;
	const digits = index === 0 ? 0 : 1;
	if (!isEnglish(locale)) {
		try {
			return new Intl.NumberFormat(locale, {
				maximumFractionDigits: digits,
				minimumFractionDigits: digits,
				style: "unit",
				unit: BYTE_UNITS[index],
				unitDisplay: "short",
			}).format(value);
		} catch {
			// An unsupported locale falls back to the English form.
		}
	}
	return `${value.toFixed(digits)} ${ENGLISH_BYTE_UNITS[index]}`;
}

function relativeTime(locale: string, value: number, unit: "minute" | "hour") {
	return new Intl.RelativeTimeFormat(locale, {
		numeric: "auto",
		style: "short",
	}).format(-value, unit);
}

/**
 * How long ago `timestamp` was: "Just now" under a minute, minutes under an
 * hour, hours under a day, then a short date in `dateLocale` (the theme's
 * `--ryu-locale` when the caller has one) and `timeZone`.
 */
export function formatAge(
	timestamp: number,
	now: number,
	options: { dateLocale?: string; locale?: string; timeZone?: string } = {}
): string {
	const locale = options.locale ?? shellLocale();
	const age = Math.max(0, now - timestamp);
	const english = isEnglish(locale);
	try {
		if (age < MINUTE_MS) {
			return english
				? "Just now"
				: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
						0,
						"second"
					);
		}
		if (age < HOUR_MS) {
			const minutes = Math.floor(age / MINUTE_MS);
			return english
				? `${minutes} min ago`
				: relativeTime(locale, minutes, "minute");
		}
		if (age < DAY_MS) {
			const hours = Math.floor(age / HOUR_MS);
			return english ? `${hours} hr ago` : relativeTime(locale, hours, "hour");
		}
	} catch {
		// Fall through to the date for a locale `Intl` cannot read.
	}
	const date = new Date(timestamp);
	// English with no theme locale keeps the system's own date conventions.
	const dateLocale = options.dateLocale ?? (english ? undefined : locale);
	try {
		return new Intl.DateTimeFormat(dateLocale, {
			day: "numeric",
			month: "short",
			timeZone: options.timeZone,
		}).format(date);
	} catch {
		return new Intl.DateTimeFormat(dateLocale, {
			day: "numeric",
			month: "short",
		}).format(date);
	}
}
