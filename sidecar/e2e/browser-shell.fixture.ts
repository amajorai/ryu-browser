import type { Page } from "@playwright/test";
import type {
	BrowserState,
	BrowserTabState,
} from "../src/main/browser-state.ts";

export interface BrowserShellEffect {
	args: unknown[];
	method: string;
}

export interface BrowserShellFixtureApi {
	addFailure(method: string, message: string): void;
	calls: BrowserShellEffect[];
	emitTheme(tokens: Record<string, string>): void;
	getFindableText(): string;
	getFindResult(): { activeMatchOrdinal: number; matches: number } | null;
	getOverlayVisible(): boolean;
	getState(): BrowserState;
}

declare global {
	interface Window {
		__browserShellFixture?: BrowserShellFixtureApi;
	}
}

interface BrowserShellInitPayload {
	findableText: string;
	initialFailures: Record<string, string[]>;
	initialState: BrowserState;
}

const FIXTURE_URL = "https://start.example.test/";
export const FINDABLE_PAGE_TEXT =
	"Browser tabs open pages. Browser settings manage permissions. Ryu Browser find reads page text.";

function tab(
	id: string,
	url = FIXTURE_URL,
	title = "Start page"
): BrowserTabState {
	return {
		canGoBack: false,
		canGoForward: false,
		id,
		loading: false,
		title,
		url,
		zoomPercent: 100,
	};
}

export function makeBrowserState(
	overrides: Partial<BrowserState> = {}
): BrowserState {
	const tabs = overrides.tabs ?? [tab("tab-start")];
	const activeId =
		overrides.activeId === undefined
			? (tabs[0]?.id ?? null)
			: overrides.activeId;
	const activeTab = tabs.find((candidate) => candidate.id === activeId);
	const now = Date.now();
	const base: BrowserState = {
		activeId,
		activeTitle: activeTab?.title ?? "",
		activeUrl: activeTab?.url ?? "about:blank",
		activities: [],
		cdpRestartRequired: false,
		deviceToolbar: false,
		downloads: [
			{
				filename: "release-notes.pdf",
				id: "download-1",
				path: "/fixture/Downloads/release-notes.pdf",
				percent: 100,
				receivedBytes: 4096,
				state: "completed",
				totalBytes: 4096,
				updatedAt: now,
				url: "https://docs.example.test/release-notes.pdf",
			},
		],
		extensions: [],
		history: [
			{
				id: "history-1",
				title: "Earlier browser guide",
				url: "https://docs.example.test/previous",
				visitedAt: now - 120_000,
			},
		],
		settings: {
			allowControl: true,
			annotationScreenshots: "always",
			approval: "always-allow",
			askWhereToSave: false,
			developerCdp: false,
			downloadDirectory: "System Downloads folder",
			historyAccess: "always-ask",
			localLinkDestination: "ryu",
			sitePermissions: [],
			webLinkDestination: "default",
		},
		surface: "browser",
		tabs,
	};
	const state = {
		...base,
		...overrides,
		activeId,
		activeTitle: overrides.activeTitle ?? base.activeTitle,
		activeUrl: overrides.activeUrl ?? base.activeUrl,
		downloads: overrides.downloads ?? base.downloads,
		history: overrides.history ?? base.history,
		settings: { ...base.settings, ...overrides.settings },
		tabs,
	};
	return state;
}

export async function installBrowserShellFixture(
	page: Page,
	state: BrowserState = makeBrowserState(),
	failures: Record<string, string[]> = {}
): Promise<void> {
	// SAFETY: Playwright's native addInitScript serializes this callback and the
	// JSON-only BrowserState payload without JSHandle unboxing. Its recursive
	// Unboxed type exceeds TypeScript's depth for the actual native JSON owner;
	// this callable ABI keeps the same receiver, callback, argument and result.
	await (
		page.addInitScript as (
			script: (payload: BrowserShellInitPayload) => void,
			payload: BrowserShellInitPayload
		) => ReturnType<Page["addInitScript"]>
	)(
		({
			initialState,
			initialFailures,
			findableText,
		}: BrowserShellInitPayload) => {
			const clone = <T>(value: T): T => structuredClone(value);
			let currentState = clone(initialState);
			let findResult: { activeMatchOrdinal: number; matches: number } | null =
				null;
			let lastFindQuery = "";
			let activeFindMatch = 0;
			let visibleOverlay = false;
			let nextTabId = 2;
			const calls: BrowserShellEffect[] = [];
			const failures = clone(initialFailures);
			const stateListeners = new Set<(next: BrowserState) => void>();
			const findListeners = new Set<
				(result: { activeMatchOrdinal: number; matches: number }) => void
			>();
			const themeListeners = new Set<
				(tokens: Record<string, string>) => void
			>();
			let theme: Awaited<
				ReturnType<NonNullable<Window["ryuBrowser"]>["getTheme"]>
			> = {
				"--background": "#101112",
				"--foreground": "#eeeeef",
				"--primary": "#0099ff",
			};
			const backStack: string[] = [];
			const forwardStack: string[] = [];

			function record(method: string, args: unknown[]): void {
				calls.push({ method, args: clone(args) });
				const failure = failures[method]?.shift();
				if (failure) {
					throw new Error(failure);
				}
			}

			function publish(next: BrowserState): BrowserState {
				currentState = clone(next);
				for (const listener of stateListeners) {
					listener(clone(currentState));
				}
				return clone(currentState);
			}

			async function updateState(
				method: string,
				args: unknown[],
				update: (next: BrowserState) => void
			): Promise<BrowserState> {
				record(method, args);
				const next = clone(currentState);
				update(next);
				return publish(next);
			}

			async function runEffect(
				method: string,
				args: unknown[] = []
			): Promise<void> {
				record(method, args);
			}

			function activeTab(next = currentState): BrowserTabState | undefined {
				return next.tabs.find((candidate) => candidate.id === next.activeId);
			}

			function updateActiveUrl(next: BrowserState, url: string): void {
				const current = activeTab(next);
				if (!current) {
					return;
				}
				current.url = url;
				current.title =
					url === "about:blank" ? "New tab" : new URL(url).hostname;
				current.canGoBack = backStack.length > 0;
				current.canGoForward = forwardStack.length > 0;
				next.activeUrl = current.url;
				next.activeTitle = current.title;
			}

			const bridge = {
				addSitePermission: (
					permission: BrowserState["settings"]["sitePermissions"][number]
				) =>
					updateState("addSitePermission", [permission], (next) => {
						const existing = next.settings.sitePermissions.findIndex(
							(candidate) =>
								candidate.origin === permission.origin &&
								candidate.permission === permission.permission
						);
						if (existing >= 0) {
							next.settings.sitePermissions[existing] = clone(permission);
						} else {
							next.settings.sitePermissions.push(clone(permission));
						}
					}),
				back: () =>
					updateState("back", [], (next) => {
						const destination = backStack.pop();
						if (destination) {
							forwardStack.push(next.activeUrl);
							updateActiveUrl(next, destination);
						}
					}),
				chooseDownloadDirectory: () =>
					updateState("chooseDownloadDirectory", [], (next) => {
						next.settings.downloadDirectory = "/fixture/Exports";
					}),
				chooseExtensionDirectory: () =>
					updateState("chooseExtensionDirectory", [], (next) => {
						if (
							!next.extensions.some(
								(extension) => extension.id === "fixture-extension"
							)
						) {
							next.extensions.push({
								id: "fixture-extension",
								name: "Fixture extension",
								version: "1.2.3",
							});
						}
					}),
				clearBrowsingData: () =>
					updateState("clearBrowsingData", [], (next) => {
						next.history = [];
						next.downloads = [];
					}),
				clearDownloads: () =>
					updateState("clearDownloads", [], (next) => {
						next.downloads = [];
					}),
				clearHistory: () =>
					updateState("clearHistory", [], (next) => {
						next.history = [];
					}),
				close: (id: string) =>
					updateState("close", [id], (next) => {
						next.tabs = next.tabs.filter((candidate) => candidate.id !== id);
						if (next.activeId === id) {
							const replacement = next.tabs[0];
							next.activeId = replacement?.id ?? null;
							next.activeTitle = replacement?.title ?? "";
							next.activeUrl = replacement?.url ?? "about:blank";
						}
					}),
				find: async (query: string) => {
					await runEffect("find", [query]);
					const normalizedQuery = query.trim().toLocaleLowerCase();
					const normalizedText = findableText.toLocaleLowerCase();
					let matches = 0;
					let offset = 0;
					while (normalizedQuery.length > 0) {
						const nextMatch = normalizedText.indexOf(normalizedQuery, offset);
						if (nextMatch < 0) {
							break;
						}
						matches += 1;
						offset = nextMatch + normalizedQuery.length;
					}
					activeFindMatch =
						matches === 0
							? 0
							: normalizedQuery === lastFindQuery
								? (activeFindMatch % matches) + 1
								: 1;
					lastFindQuery = normalizedQuery;
					findResult = {
						activeMatchOrdinal: activeFindMatch,
						matches,
					};
					for (const listener of findListeners) {
						listener(clone(findResult));
					}
				},
				forward: () =>
					updateState("forward", [], (next) => {
						const destination = forwardStack.pop();
						if (destination) {
							backStack.push(next.activeUrl);
							updateActiveUrl(next, destination);
						}
					}),
				getState: async () => clone(currentState),
				getTheme: async () => clone(theme),
				importCookies: async () => {
					record("importCookies", []);
					return { imported: 3 };
				},
				onFind: (
					listener: (result: {
						activeMatchOrdinal: number;
						matches: number;
					}) => void
				) => {
					findListeners.add(listener);
					return () => findListeners.delete(listener);
				},
				onState: (listener: (next: BrowserState) => void) => {
					stateListeners.add(listener);
					return () => stateListeners.delete(listener);
				},
				onTheme: (listener: (tokens: Record<string, string>) => void) => {
					themeListeners.add(listener);
					return () => themeListeners.delete(listener);
				},
				open: (url?: string) =>
					updateState("open", [url ?? null], (next) => {
						const openUrl = url || "about:blank";
						const newTab: BrowserTabState = {
							canGoBack: false,
							canGoForward: false,
							id: `tab-fixture-${nextTabId}`,
							loading: false,
							title:
								openUrl === "about:blank"
									? "New tab"
									: new URL(openUrl).hostname,
							url: openUrl,
							zoomPercent: 100,
						};
						nextTabId += 1;
						next.tabs.push(newTab);
						next.activeId = newTab.id;
						next.activeTitle = newTab.title;
						next.activeUrl = newTab.url;
					}),
				openDownloadsFolder: () => runEffect("openDownloadsFolder"),
				openDevTools: () => runEffect("openDevTools"),
				navigate: (url: string) =>
					updateState("navigate", [url], (next) => {
						if (next.activeUrl && next.activeUrl !== url) {
							backStack.push(next.activeUrl);
							forwardStack.length = 0;
						}
						updateActiveUrl(next, url);
						next.history.unshift({
							id: `history-${next.history.length + 1}`,
							title: next.activeTitle,
							url,
							visitedAt: Date.now(),
						});
					}),
				removeExtension: (id: string) =>
					updateState("removeExtension", [id], (next) => {
						next.extensions = next.extensions.filter(
							(extension) => extension.id !== id
						);
					}),
				removeSitePermission: (origin: string, permission: string) =>
					updateState("removeSitePermission", [origin, permission], (next) => {
						next.settings.sitePermissions =
							next.settings.sitePermissions.filter(
								(candidate) =>
									candidate.origin !== origin ||
									candidate.permission !== permission
							);
					}),
				reload: () => updateState("reload", [], () => undefined),
				select: (id: string) =>
					updateState("select", [id], (next) => {
						const selected = next.tabs.find((candidate) => candidate.id === id);
						if (selected) {
							next.activeId = selected.id;
							next.activeTitle = selected.title;
							next.activeUrl = selected.url;
						}
					}),
				setCdpEnabled: (enabled: boolean) =>
					updateState("setCdpEnabled", [enabled], (next) => {
						next.settings.developerCdp = enabled;
						next.cdpRestartRequired = true;
					}),
				setOverlayVisible: async (visible: boolean) => {
					visibleOverlay = visible;
				},
				setSetting: (
					key: keyof BrowserState["settings"],
					value: BrowserState["settings"][keyof BrowserState["settings"]]
				) =>
					updateState("setSetting", [key, value], (next) => {
						Object.assign(next.settings, { [key]: value });
					}),
				setSurface: (surface: BrowserState["surface"]) =>
					updateState("setSurface", [surface], (next) => {
						next.surface = surface;
					}),
				showScreenshot: async () => {
					record("showScreenshot", []);
					return { saved: true, path: "/fixture/Downloads/browser-page.png" };
				},
				stopFind: () => runEffect("stopFind"),
				toggleDeviceToolbar: () =>
					updateState("toggleDeviceToolbar", [], (next) => {
						next.deviceToolbar = !next.deviceToolbar;
					}),
				zoom: (action: "in" | "out" | "reset") =>
					updateState("zoom", [action], (next) => {
						const current = next.tabs.find(
							(candidate) => candidate.id === next.activeId
						);
						if (current) {
							current.zoomPercent =
								action === "reset"
									? 100
									: current.zoomPercent + (action === "in" ? 10 : -10);
						}
					}),
			};

			window.ryuBrowser = bridge;
			window.__browserShellFixture = {
				addFailure(method: string, message: string) {
					let queue = failures[method];
					if (!queue) {
						queue = [];
						failures[method] = queue;
					}
					queue.push(message);
				},
				calls,
				emitTheme(tokens: Record<string, string>) {
					theme = clone(tokens);
					for (const listener of themeListeners) {
						listener(clone(theme));
					}
				},
				getFindableText: () => findableText,
				getFindResult: () => clone(findResult),
				getOverlayVisible: () => visibleOverlay,
				getState: () => clone(currentState),
			};
		},
		{
			initialState: state,
			initialFailures: failures,
			findableText: FINDABLE_PAGE_TEXT,
		}
	);
}
