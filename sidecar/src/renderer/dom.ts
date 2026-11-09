import { tl } from "../i18n/shell-i18n.ts";

let toastTimer: number | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

export function button(
	label: string,
	className = "icon-button",
	onClick?: () => void,
	ariaLabel = label
): HTMLButtonElement {
	const node = el("button", className, label);
	node.type = "button";
	node.setAttribute("aria-label", ariaLabel);
	if (onClick) {
		node.addEventListener("click", onClick);
	}
	return node;
}

export function appendChildren(
	parent: HTMLElement,
	...children: (Node | null)[]
): void {
	for (const child of children) {
		if (child) {
			parent.append(child);
		}
	}
}

export function showToast(message: string): void {
	const existing = document.querySelector(".toast");
	existing?.remove();
	const toast = el("div", "toast", message);
	document.body.append(toast);
	if (toastTimer !== undefined) {
		window.clearTimeout(toastTimer);
	}
	toastTimer = window.setTimeout(() => toast.remove(), 3600);
}

export function sectionHeading(
	title: string,
	action?: HTMLElement
): HTMLElement {
	const heading = el("div", "section-heading");
	heading.append(el("h2", "section-title", title));
	if (action) {
		heading.append(action);
	}
	return heading;
}

export function card(...rows: HTMLElement[]): HTMLElement {
	const node = el("section", "settings-card");
	for (const row of rows) {
		node.append(row);
	}
	return node;
}

export function row(
	label: string,
	description: string,
	control: HTMLElement
): HTMLElement {
	const node = el("div", "settings-row");
	const copy = el("div", "row-copy");
	copy.append(
		el("div", "row-label", label),
		el("div", "row-description", description)
	);
	node.append(copy, control);
	return node;
}

export function selectControl<const T extends string>(
	value: T,
	options: T[],
	onChange: (value: T) => void,
	label: (option: T) => string
): HTMLSelectElement {
	const select = el("select", "select-control");
	for (const option of options) {
		const item = el("option", undefined, label(option));
		item.value = option;
		item.selected = option === value;
		select.append(item);
	}
	select.addEventListener("change", () => {
		const selected = options.find((option) => option === select.value);
		if (selected !== undefined) {
			onChange(selected);
		}
	});
	return select;
}

export function toggle(
	checked: boolean,
	onChange: (checked: boolean) => void
): HTMLButtonElement {
	const control = button(
		"",
		`toggle ${checked ? "on" : ""}`,
		() => {
			onChange(!checked);
		},
		checked ? tl("On") : tl("Off")
	);
	control.setAttribute("aria-checked", String(checked));
	control.setAttribute("role", "switch");
	control.append(el("span", "toggle-knob"));
	return control;
}
