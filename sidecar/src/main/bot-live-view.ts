// Read-only live view of a managed Bot's hidden tab lane.
//
// A Bot lane is a hidden window: the person who owns the agent cannot see what
// it is doing in the browser. While a viewer is watching a lane tab, the
// sidecar runs a CDP screencast (`Page.startScreencast`) on that tab and keeps
// the latest JPEG frame; the viewer polls it through the control server
// (`control-live-view.ts`). A hidden window may paint rarely, so a frame that is
// missing or stale is refreshed from a page capture instead.
//
// The view is read-only: it never sends input to the lane. A screencast stops
// when nobody has read a frame for `LIVE_VIEW_IDLE_MS`, when its tab goes away,
// or when the viewer stops it, and only `MAX_LIVE_VIEWS` run at once.

import { z } from "zod";

/** The slice of one tab's CDP session and contents a live view needs. */
export interface LiveViewSource {
	/** One page capture, used when the screencast has no fresh frame. */
	capture(): Promise<LiveViewImage | null>;
	/** Subscribe to the tab's CDP events; returns the unsubscribe function. */
	onMessage(listener: (method: string, params: unknown) => void): () => void;
	/** Send one CDP command on the tab's debugger session. */
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface LiveViewImage {
	height: number;
	/** Base64 JPEG. */
	image: string;
	width: number;
}

export interface LiveFrame extends LiveViewImage {
	captured_at: string;
	mime: "image/jpeg";
	/** Increases with every new frame of this view, so a viewer can skip repaints. */
	seq: number;
	via: "capture" | "screencast";
}

export const LIVE_VIEW_IDLE_MS = 15_000;
export const MAX_LIVE_VIEWS = 4;
/** How long a frame request waits for the screencast before capturing instead. */
export const LIVE_VIEW_FRAME_WAIT_MS = 400;
/** A screencast frame older than this is refreshed from a capture. */
export const LIVE_VIEW_STALE_MS = 2000;

export const SCREENCAST_PARAMS = {
	everyNthFrame: 1,
	format: "jpeg",
	maxHeight: 900,
	maxWidth: 1440,
	quality: 60,
} as const;

const screencastFrameSchema = z.object({
	data: z.string().min(1),
	metadata: z
		.object({
			deviceHeight: z.number().nonnegative().optional(),
			deviceWidth: z.number().nonnegative().optional(),
		})
		.optional(),
	sessionId: z.number().int(),
});

export interface LiveViewOptions {
	frameWaitMs?: number;
	idleMs?: number;
	maxViews?: number;
	now?: () => number;
	staleMs?: number;
}

interface Settings {
	frameWaitMs: number;
	idleMs: number;
	maxViews: number;
	now: () => number;
	staleMs: number;
}

class LaneScreencast {
	private latest: (LiveFrame & { at: number }) | null = null;
	private seq = 0;
	private unsubscribe: (() => void) | null = null;
	private readonly waiters: (() => void)[] = [];
	private stopped = false;
	lastRead: number;

	constructor(
		private readonly source: LiveViewSource,
		private readonly settings: Settings
	) {
		this.lastRead = settings.now();
	}

	async start(): Promise<void> {
		this.unsubscribe = this.source.onMessage((method, params) =>
			this.handle(method, params)
		);
		try {
			await this.source.send("Page.startScreencast", { ...SCREENCAST_PARAMS });
		} catch (error) {
			this.stop();
			throw error;
		}
	}

	private handle(method: string, params: unknown): void {
		if (this.stopped || method !== "Page.screencastFrame") {
			return;
		}
		const parsed = screencastFrameSchema.safeParse(params);
		if (!parsed.success) {
			return;
		}
		const frame = parsed.data;
		// Chromium sends the next frame only after this one is acknowledged.
		this.source
			.send("Page.screencastFrameAck", { sessionId: frame.sessionId })
			.catch(() => undefined);
		this.store(
			{
				height: frame.metadata?.deviceHeight ?? 0,
				image: frame.data,
				width: frame.metadata?.deviceWidth ?? 0,
			},
			"screencast"
		);
	}

	private store(image: LiveViewImage, via: LiveFrame["via"]): LiveFrame {
		const at = this.settings.now();
		this.seq += 1;
		this.latest = {
			...image,
			at,
			captured_at: new Date(at).toISOString(),
			mime: "image/jpeg",
			seq: this.seq,
			via,
		};
		for (const wake of this.waiters.splice(0)) {
			wake();
		}
		return this.latest;
	}

	private fresh(): LiveFrame | null {
		const latest = this.latest;
		if (!latest || this.settings.now() - latest.at > this.settings.staleMs) {
			return null;
		}
		return publicFrame(latest);
	}

	async frame(): Promise<LiveFrame | null> {
		this.lastRead = this.settings.now();
		const current = this.fresh();
		if (current) {
			return current;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, this.settings.frameWaitMs);
			this.waiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
		const pushed = this.fresh();
		if (pushed || this.stopped) {
			return pushed;
		}
		const captured = await this.source.capture().catch(() => null);
		if (this.stopped) {
			return null;
		}
		if (captured) {
			return publicFrame(this.store(captured, "capture"));
		}
		return this.latest ? publicFrame(this.latest) : null;
	}

	stop(): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		for (const wake of this.waiters.splice(0)) {
			wake();
		}
		this.source.send("Page.stopScreencast").catch(() => undefined);
	}
}

function publicFrame(frame: LiveFrame & { at?: number }): LiveFrame {
	return {
		captured_at: frame.captured_at,
		height: frame.height,
		image: frame.image,
		mime: frame.mime,
		seq: frame.seq,
		via: frame.via,
		width: frame.width,
	};
}

export type LiveViewResult =
	| { frame: LiveFrame | null; kind: "frame" }
	| { kind: "busy" };

/** Every running Bot-lane screencast, keyed by lane and tab. */
export class BotLiveViews {
	private readonly casts = new Map<string, Promise<LaneScreencast>>();
	private readonly settings: Settings;

	constructor(options: LiveViewOptions = {}) {
		this.settings = {
			frameWaitMs: options.frameWaitMs ?? LIVE_VIEW_FRAME_WAIT_MS,
			idleMs: options.idleMs ?? LIVE_VIEW_IDLE_MS,
			maxViews: options.maxViews ?? MAX_LIVE_VIEWS,
			now: options.now ?? Date.now,
			staleMs: options.staleMs ?? LIVE_VIEW_STALE_MS,
		};
	}

	/** Number of screencasts currently running or starting. */
	get size(): number {
		return this.casts.size;
	}

	/** The latest frame of a lane tab, starting its screencast on first use. */
	async frame(
		lane: string,
		tabId: string,
		source: LiveViewSource
	): Promise<LiveViewResult> {
		await this.sweep();
		const key = viewKey(lane, tabId);
		let cast = this.casts.get(key);
		if (!cast) {
			if (this.casts.size >= this.settings.maxViews) {
				return { kind: "busy" };
			}
			const created = new LaneScreencast(source, this.settings);
			cast = created.start().then(() => created);
			this.casts.set(key, cast);
			cast.catch(() => this.casts.delete(key));
		}
		const running = await cast;
		return { frame: await running.frame(), kind: "frame" };
	}

	/** Stop one view; false when it was not running. */
	stop(lane: string, tabId: string): boolean {
		const key = viewKey(lane, tabId);
		const cast = this.casts.get(key);
		if (!cast) {
			return false;
		}
		this.casts.delete(key);
		cast.then((running) => running.stop()).catch(() => undefined);
		return true;
	}

	/** Stop every view nobody has read within the idle window. */
	async sweep(): Promise<void> {
		const cutoff = this.settings.now() - this.settings.idleMs;
		for (const [key, cast] of [...this.casts]) {
			const running = await cast.catch(() => null);
			if (running && running.lastRead < cutoff) {
				if (this.casts.get(key) === cast) {
					this.casts.delete(key);
				}
				running.stop();
			}
		}
	}

	stopAll(): void {
		for (const cast of this.casts.values()) {
			cast.then((running) => running.stop()).catch(() => undefined);
		}
		this.casts.clear();
	}
}

function viewKey(lane: string, tabId: string): string {
	return JSON.stringify([lane, tabId]);
}
