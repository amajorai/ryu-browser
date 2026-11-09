/**
 * The ICU subset the browser shell's `tl()` messages use: `{name}`
 * arguments, and `plural` / `select` arguments whose branches may nest further
 * arguments and use `#`. Plural categories come from `Intl.PluralRules` for
 * the shell locale, and `#` is the count in that locale's digits.
 */

export type MessageValue = string | number;
export type MessageValues = Readonly<Record<string, MessageValue>>;

interface Branch {
	body: string;
	key: string;
}

const ARGUMENT_NAME = /^[A-Za-z_]\w*$/u;

/** Index of the `}` that closes the `{` at `open`, or -1. */
function closingBrace(source: string, open: number): number {
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		const character = source[index];
		if (character === "{") {
			depth += 1;
		} else if (character === "}") {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

/** Parse `key {body} key {body}` branch lists; null when malformed. */
function parseBranches(source: string): Branch[] | null {
	const branches: Branch[] = [];
	let index = 0;
	while (index < source.length) {
		const open = source.indexOf("{", index);
		if (open === -1) {
			return source.slice(index).trim() ? null : branches;
		}
		const key = source.slice(index, open).trim();
		const close = closingBrace(source, open);
		if (!key || close === -1) {
			return null;
		}
		branches.push({ key, body: source.slice(open + 1, close) });
		index = close + 1;
	}
	return branches;
}

function pluralCategory(locale: string, count: number): string {
	try {
		return new Intl.PluralRules(locale).select(count);
	} catch {
		return count === 1 ? "one" : "other";
	}
}

function formatCount(locale: string, count: number): string {
	try {
		return new Intl.NumberFormat(locale).format(count);
	} catch {
		return String(count);
	}
}

interface FormatContext {
	locale: string;
	pound: string | undefined;
	values: MessageValues;
}

/** Format one `{…}` argument; null keeps the original text. */
function formatArgument(inner: string, context: FormatContext): string | null {
	const [rawName = "", rawType, ...rest] = inner.split(",");
	const name = rawName.trim();
	if (!ARGUMENT_NAME.test(name)) {
		return null;
	}
	const value = context.values[name];
	if (value === undefined) {
		return null;
	}
	const type = rawType?.trim();
	if (type === undefined) {
		return String(value);
	}
	const branches = parseBranches(rest.join(","));
	if (!branches) {
		return null;
	}
	if (type === "plural") {
		const count = Number(value);
		const branch =
			branches.find((candidate) => candidate.key === `=${count}`) ??
			branches.find(
				(candidate) => candidate.key === pluralCategory(context.locale, count)
			) ??
			branches.find((candidate) => candidate.key === "other");
		return branch
			? format(branch.body, {
					...context,
					pound: formatCount(context.locale, count),
				})
			: null;
	}
	if (type === "select") {
		const key = String(value);
		const branch =
			branches.find((candidate) => candidate.key === key) ??
			branches.find((candidate) => candidate.key === "other");
		return branch ? format(branch.body, context) : null;
	}
	return null;
}

function format(source: string, context: FormatContext): string {
	let output = "";
	let index = 0;
	while (index < source.length) {
		const character = source[index] ?? "";
		if (character === "#" && context.pound !== undefined) {
			output += context.pound;
			index += 1;
			continue;
		}
		const close = character === "{" ? closingBrace(source, index) : -1;
		if (close === -1) {
			output += character;
			index += 1;
			continue;
		}
		const inner = source.slice(index + 1, close);
		output += formatArgument(inner, context) ?? `{${inner}}`;
		index = close + 1;
	}
	return output;
}

/** Format an ICU `message` in `locale` with `values`. */
export function formatMessage(
	message: string,
	values: MessageValues = {},
	locale = "en"
): string {
	return format(message, { locale, pound: undefined, values });
}
