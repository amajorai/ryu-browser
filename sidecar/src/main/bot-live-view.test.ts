import { describe, expect, it } from "bun:test";
import {
	BotLiveViews,
	type LiveViewImage,
	type LiveViewSource,
	SCREENCAST_PARAMS,
} from "./bot-live-view.ts";

type Listener = (method: string, params: unknown) => void;

class FakeSource implements LiveViewSource {
	readonly sent: { method: string; params?: Record<string, unknown> }[] = [];
	listeners: Listener[] = [];
	captures = 0;
	captureImage: LiveViewImage | null = {
		height: 600,
		image: "captured",
		width: 800,
	};
	failStart = false;

	capture(): Promise<LiveViewImage | null> {
		this.captures += 1;
		return Promise.resolve(this.captureImage);
	}

	onMessage(listener: Listener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((item) => item !== listener);
		};
	}

	send(method: string, params?: Record<string, unknown>): Promise<unknown> {
		this.sent.push({ method, params });
		if (this.failStart && method === "Page.startScreencast") {
			return Promise.reject(new Error("debugger busy"));
		}
		return Promise.resolve({});
	}

	push(data: string, sessionId: number): void {
		for (const listener of this.listeners) {
			listener("Page.screencastFrame", {
				data,
				metadata: { deviceHeight: 720, deviceWidth: 1280 },
				sessionId,
			});
		}
	}

	methods(): string[] {
		return this.sent.map((entry) => entry.method);
	}
}

function clock(start = 1_000_000) {
	let now = start;
	return {
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now,
	};
}

describe("BotLiveViews", () => {
	it("starts a screencast and serves its frames with a rising seq", async () => {
		const time = clock();
		const views = new BotLiveViews({ frameWaitMs: 50, now: time.now });
		const source = new FakeSource();
		const pending = views.frame("agent-a", "t1", source);
		await Promise.resolve();
		await Promise.resolve();
		source.push("frame-1", 7);
		const first = await pending;
		expect(first.kind).toBe("frame");
		if (first.kind !== "frame") {
			return;
		}
		expect(first.frame).toMatchObject({
			height: 720,
			image: "frame-1",
			mime: "image/jpeg",
			seq: 1,
			via: "screencast",
			width: 1280,
		});
		expect(source.sent[0]).toEqual({
			method: "Page.startScreencast",
			params: { ...SCREENCAST_PARAMS },
		});
		// Every frame is acknowledged, or Chromium stops sending them.
		expect(source.sent).toContainEqual({
			method: "Page.screencastFrameAck",
			params: { sessionId: 7 },
		});
		source.push("frame-2", 8);
		const second = await views.frame("agent-a", "t1", source);
		expect(second.kind === "frame" && second.frame?.seq).toBe(2);
		expect(second.kind === "frame" && second.frame?.image).toBe("frame-2");
		// One screencast per lane tab, however often it is read.
		expect(
			source.methods().filter((method) => method === "Page.startScreencast")
		).toHaveLength(1);
		expect(source.captures).toBe(0);
	});

	it("falls back to a capture when the hidden page paints nothing", async () => {
		const time = clock();
		const views = new BotLiveViews({ frameWaitMs: 1, now: time.now });
		const source = new FakeSource();
		const result = await views.frame("agent-a", "t1", source);
		expect(result.kind === "frame" && result.frame).toMatchObject({
			image: "captured",
			seq: 1,
			via: "capture",
		});
		// A stale screencast frame is refreshed from a capture as well.
		source.push("old", 1);
		time.advance(5000);
		const later = await views.frame("agent-a", "t1", source);
		expect(later.kind === "frame" && later.frame?.via).toBe("capture");
		expect(source.captures).toBe(2);
	});

	it("reports no frame yet instead of failing when nothing can be captured", async () => {
		const views = new BotLiveViews({ frameWaitMs: 1 });
		const source = new FakeSource();
		source.captureImage = null;
		const result = await views.frame("agent-a", "t1", source);
		expect(result).toEqual({ frame: null, kind: "frame" });
	});

	it("ignores malformed screencast events", async () => {
		const views = new BotLiveViews({ frameWaitMs: 1 });
		const source = new FakeSource();
		source.captureImage = null;
		const pending = views.frame("agent-a", "t1", source);
		await Promise.resolve();
		for (const listener of source.listeners) {
			listener("Page.screencastFrame", { data: 42 });
			listener("Page.frameNavigated", { data: "x", sessionId: 1 });
		}
		expect(await pending).toEqual({ frame: null, kind: "frame" });
		expect(source.methods()).not.toContain("Page.screencastFrameAck");
	});

	it("caps the number of running views", async () => {
		const views = new BotLiveViews({ frameWaitMs: 1, maxViews: 2 });
		await views.frame("a", "t1", new FakeSource());
		await views.frame("b", "t1", new FakeSource());
		expect(await views.frame("c", "t1", new FakeSource())).toEqual({
			kind: "busy",
		});
		expect(views.stop("a", "t1")).toBe(true);
		expect((await views.frame("c", "t1", new FakeSource())).kind).toBe("frame");
	});

	it("stops a view on request and releases the screencast", async () => {
		const views = new BotLiveViews({ frameWaitMs: 1 });
		const source = new FakeSource();
		await views.frame("agent-a", "t1", source);
		expect(views.stop("agent-a", "t1")).toBe(true);
		expect(views.stop("agent-a", "t1")).toBe(false);
		await Promise.resolve();
		await Promise.resolve();
		expect(source.methods()).toContain("Page.stopScreencast");
		expect(source.listeners).toHaveLength(0);
		expect(views.size).toBe(0);
	});

	it("stops views nobody has read within the idle window", async () => {
		const time = clock();
		const views = new BotLiveViews({
			frameWaitMs: 1,
			idleMs: 1000,
			now: time.now,
		});
		const idle = new FakeSource();
		const watched = new FakeSource();
		await views.frame("agent-a", "t1", idle);
		time.advance(600);
		await views.frame("agent-b", "t1", watched);
		time.advance(600);
		await views.sweep();
		expect(views.size).toBe(1);
		expect(idle.methods()).toContain("Page.stopScreencast");
		expect(watched.methods()).not.toContain("Page.stopScreencast");
	});

	it("forgets a view whose screencast could not start", async () => {
		const views = new BotLiveViews({ frameWaitMs: 1 });
		const source = new FakeSource();
		source.failStart = true;
		await expect(views.frame("agent-a", "t1", source)).rejects.toThrow(
			"debugger busy"
		);
		expect(views.size).toBe(0);
		expect(source.listeners).toHaveLength(0);
	});

	it("stopAll releases every view", async () => {
		const views = new BotLiveViews({ frameWaitMs: 1 });
		const first = new FakeSource();
		const second = new FakeSource();
		await views.frame("a", "t1", first);
		await views.frame("a", "t2", second);
		views.stopAll();
		await Promise.resolve();
		await Promise.resolve();
		expect(views.size).toBe(0);
		expect(first.methods()).toContain("Page.stopScreencast");
		expect(second.methods()).toContain("Page.stopScreencast");
	});
});
