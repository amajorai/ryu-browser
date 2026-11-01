import {
	type BrowserCapturePayload,
	type BrowserCaptureProtocolRecord,
	type BrowserCaptureProtocolValue,
	browserActivityMessageSchema,
	browserCaptureBindingSchema,
	browserCaptureContextCreatedSchema,
	browserCaptureContextDestroyedSchema,
	browserCapturePayloadSchema,
	browserCaptureProtocolRecordSchema,
} from "./capture-records.ts";

export type BrowserTabActivityKind =
	| "audio"
	| "camera"
	| "microphone"
	| "screen";

export type BrowserActivityStatus = "active" | "recent";

interface BrowserActivityBase {
	detail: string;
	id: string;
	startedAt: number;
	status: BrowserActivityStatus;
	updatedAt: number;
}

export interface BrowserTabActivity extends BrowserActivityBase {
	kind: BrowserTabActivityKind;
	selectable: boolean;
	source: "browser-tab";
	tabId: string;
	tabTitle: string;
	tabUrl: string;
}

export interface BrowserComputerUseActivity extends BrowserActivityBase {
	agentLabel: string;
	kind: "computer-use";
	selectable: false;
	source: "computer-use";
	tabId?: string;
	tabTitle?: string;
}

export type BrowserActivity = BrowserComputerUseActivity | BrowserTabActivity;

export interface BrowserActivityTabInput {
	kind: BrowserTabActivityKind;
	selectable: boolean;
	tabId: string;
	tabTitle: string;
	tabUrl: string;
}

export interface BrowserComputerUseInput {
	agentId: string;
	agentLabel: string;
	selectable: false;
	tabId?: string;
	tabTitle?: string;
}

export interface BrowserActivityMessage {
	action: "start" | "clone" | "stop";
	capability: string;
	kind: BrowserTabActivityKind;
	sourceId?: string;
	trackId: number;
}

interface ActivityRecord {
	entry: BrowserActivity;
	expiresAt: number | null;
}

const COMPUTER_USE_TTL_MS = 8000;
const RECENT_ACTIVITY_TTL_MS = 15_000;

function activityDetail(kind: BrowserTabActivityKind): string {
	switch (kind) {
		case "audio":
			return "Audio and video playback";
		case "camera":
			return "Camera access";
		case "microphone":
			return "Microphone access";
		case "screen":
			return "Screen capture";
	}
}

export function isRecord(
	value: BrowserCaptureProtocolValue
): value is BrowserCaptureProtocolRecord {
	return browserCaptureProtocolRecordSchema.safeParse(value).success;
}

export function parseBrowserActivityMessage(
	payload: BrowserCapturePayload
): BrowserActivityMessage | null {
	const serialized = browserCapturePayloadSchema.safeParse(payload);
	if (!serialized.success || serialized.data === undefined) {
		return null;
	}
	try {
		const parsed = browserActivityMessageSchema.safeParse(
			JSON.parse(serialized.data)
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Only authenticated native-track observations can change capture state. */
export class BrowserCaptureMonitor {
	private readonly contexts = new Set<number>();
	private readonly tracks = new Map<string, BrowserActivityMessage["kind"]>();
	private readonly activeKinds = new Set<BrowserActivityMessage["kind"]>();
	private readonly capturedSources = new Set<string>();
	constructor(
		private readonly capability: string,
		private readonly onChange: (
			kind: BrowserActivityMessage["kind"],
			active: boolean
		) => void
	) {}
	handleMessage(method: string, params: BrowserCaptureProtocolValue): void {
		if (!isRecord(params)) {
			return;
		}
		if (method === "Runtime.executionContextCreated") {
			const created = browserCaptureContextCreatedSchema.safeParse(params);
			if (created.success) {
				this.contexts.add(created.data.context.id);
			}
			return;
		}
		if (method === "Runtime.executionContextsCleared") {
			this.contexts.clear();
			this.tracks.clear();
			this.capturedSources.clear();
			this.refresh();
			return;
		}
		if (method === "Runtime.executionContextDestroyed") {
			const destroyed = browserCaptureContextDestroyedSchema.safeParse(params);
			if (!destroyed.success) {
				return;
			}
			const id = destroyed.data.executionContextId;
			this.contexts.delete(id);
			for (const key of this.tracks.keys()) {
				if (key.startsWith(`${id}:`)) {
					this.tracks.delete(key);
				}
			}
			this.refresh();
			return;
		}
		if (method !== "Runtime.bindingCalled") {
			return;
		}
		const binding = browserCaptureBindingSchema.safeParse(params);
		if (
			!(binding.success && this.contexts.has(binding.data.executionContextId))
		) {
			return;
		}
		const message = parseBrowserActivityMessage(binding.data.payload);
		if (!message || message.capability !== this.capability) {
			return;
		}
		const key = `${binding.data.executionContextId}:${message.trackId}`;
		if (message.action === "start" || message.action === "clone") {
			const source = message.sourceId
				? `${message.kind}:${message.sourceId}`
				: null;
			if (
				message.action === "clone" &&
				!(source && this.capturedSources.has(source))
			) {
				return;
			}
			if (source) {
				this.capturedSources.add(source);
			}
			if (this.tracks.has(key)) {
				return;
			}
			this.tracks.set(key, message.kind);
		} else {
			if (this.tracks.get(key) !== message.kind) {
				return;
			}
			this.tracks.delete(key);
		}
		this.refresh();
	}
	private refresh(): void {
		const active = new Set(this.tracks.values());
		for (const kind of [
			"camera",
			"microphone",
			"screen",
		] satisfies BrowserActivityMessage["kind"][]) {
			if (active.has(kind) === this.activeKinds.has(kind)) {
				continue;
			}
			if (active.has(kind)) {
				this.activeKinds.add(kind);
			} else {
				this.activeKinds.delete(kind);
			}
			this.onChange(kind, active.has(kind));
		}
	}
}

function activityKey(input: BrowserActivityTabInput): string {
	return `tab:${input.tabId}:${input.kind}`;
}

function computerUseKey(agentId: string): string {
	return `computer-use:${agentId}`;
}

/** Ephemeral, local-only activity state for the browser chrome. */
export class BrowserActivityStore {
	private readonly entries = new Map<string, ActivityRecord>();
	private expiryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly onExpiry?: () => void) {}

	setTabActivity(
		input: BrowserActivityTabInput,
		active: boolean,
		now = Date.now()
	): void {
		const key = activityKey(input);
		if (!active) {
			this.markRecent(key, now);
			this.scheduleExpiry();
			return;
		}

		const previous = this.entries.get(key)?.entry;
		this.entries.set(key, {
			entry: {
				detail: activityDetail(input.kind),
				id: key,
				kind: input.kind,
				selectable: input.selectable,
				source: "browser-tab",
				startedAt:
					previous?.source === "browser-tab" && previous.status === "active"
						? previous.startedAt
						: now,
				status: "active",
				tabId: input.tabId,
				tabTitle: input.tabTitle,
				tabUrl: input.tabUrl,
				updatedAt: now,
			},
			expiresAt: null,
		});
		this.scheduleExpiry();
	}

	startComputerUse(input: BrowserComputerUseInput, now = Date.now()): void {
		const key = computerUseKey(input.agentId);
		const previous = this.entries.get(key)?.entry;
		const tabContext: Pick<BrowserComputerUseActivity, "tabId" | "tabTitle"> =
			{};
		if (input.tabId) {
			tabContext.tabId = input.tabId;
		}
		if (input.tabTitle) {
			tabContext.tabTitle = input.tabTitle;
		}
		this.entries.set(key, {
			entry: {
				agentLabel: input.agentLabel,
				detail: "Browser control in progress",
				id: key,
				kind: "computer-use",
				selectable: false,
				source: "computer-use",
				startedAt:
					previous?.source === "computer-use" && previous.status === "active"
						? previous.startedAt
						: now,
				status: "active",
				...tabContext,
				updatedAt: now,
			},
			expiresAt: now + COMPUTER_USE_TTL_MS,
		});
		this.scheduleExpiry();
	}

	stopComputerUse(agentId: string, now = Date.now()): void {
		this.markRecent(computerUseKey(agentId), now);
		this.scheduleExpiry();
	}

	updateTab(tabId: string, input: { title: string; url: string }): void {
		for (const [key, record] of this.entries) {
			const { entry } = record;
			if (entry.source === "browser-tab" && entry.tabId === tabId) {
				record.entry = { ...entry, tabTitle: input.title, tabUrl: input.url };
				continue;
			}
			if (entry.source === "computer-use" && entry.tabId === tabId) {
				record.entry = { ...entry, tabTitle: input.title };
			}
			this.entries.set(key, record);
		}
	}

	clearTab(tabId: string): void {
		for (const [key, record] of this.entries) {
			if (
				(record.entry.source === "browser-tab" &&
					record.entry.tabId === tabId) ||
				(record.entry.source === "computer-use" && record.entry.tabId === tabId)
			) {
				this.entries.delete(key);
			}
		}
		this.scheduleExpiry();
	}

	snapshot(now = Date.now()): BrowserActivity[] {
		for (const [key, record] of this.entries) {
			if (record.expiresAt !== null && now >= record.expiresAt) {
				if (record.entry.status === "active") {
					record.entry = {
						...record.entry,
						status: "recent",
						updatedAt: now,
					};
					record.expiresAt = now + RECENT_ACTIVITY_TTL_MS;
					this.entries.set(key, record);
				} else {
					this.entries.delete(key);
				}
			}
		}
		this.scheduleExpiry();
		return [...this.entries.values()]
			.map(({ entry }) => ({ ...entry }))
			.sort((left, right) => {
				if (left.status !== right.status) {
					return left.status === "active" ? -1 : 1;
				}
				return right.updatedAt - left.updatedAt;
			});
	}

	private markRecent(key: string, now: number): void {
		const record = this.entries.get(key);
		if (!record) {
			return;
		}
		record.entry = { ...record.entry, status: "recent", updatedAt: now };
		record.expiresAt = now + RECENT_ACTIVITY_TTL_MS;
		this.entries.set(key, record);
	}

	private scheduleExpiry(): void {
		if (this.expiryTimer !== null) {
			clearTimeout(this.expiryTimer);
			this.expiryTimer = null;
		}
		if (!this.onExpiry) {
			return;
		}
		const nextExpiry = [...this.entries.values()]
			.map(({ expiresAt }) => expiresAt)
			.filter((expiresAt): expiresAt is number => expiresAt !== null)
			.sort((left, right) => left - right)[0];
		if (nextExpiry === undefined) {
			return;
		}
		this.expiryTimer = setTimeout(
			() => {
				this.expiryTimer = null;
				this.snapshot();
				this.onExpiry?.();
			},
			Math.max(0, nextExpiry - Date.now())
		);
	}
}
