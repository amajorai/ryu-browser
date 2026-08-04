// Ryu Browser tab-strip renderer. Minimal by design: it reflects the tab list the
// main process pushes; opening/navigating tabs is driven by the loopback control
// server (Core / the desktop panel), not by chrome here. Window-choreography polish
// (clickable tabs, an address bar) is a followup.

interface TabInfo {
	id: string;
	title: string;
	url: string;
}

interface RyuBrowserBridge {
	list(): Promise<TabInfo[]>;
	onTabs(cb: (tabs: TabInfo[]) => void): void;
}

declare global {
	interface Window {
		ryuBrowser?: RyuBrowserBridge;
	}
}

const strip = document.getElementById("strip");

const STRIP_STYLE =
	"display:flex;gap:6px;align-items:center;height:40px;padding:0 10px;" +
	"font:12px system-ui,sans-serif;background:#1c1c1e;color:#e5e5e7;overflow-x:auto;";

function render(tabs: TabInfo[]): void {
	if (!strip) {
		return;
	}
	strip.setAttribute("style", STRIP_STYLE);
	strip.textContent = "";
	if (tabs.length === 0) {
		const empty = document.createElement("span");
		empty.textContent = "Ryu Browser — no tabs";
		empty.setAttribute("style", "opacity:0.6;");
		strip.append(empty);
		return;
	}
	for (const tab of tabs) {
		const chip = document.createElement("span");
		chip.textContent = tab.title || tab.url || tab.id;
		chip.setAttribute(
			"style",
			"padding:4px 10px;border-radius:6px;background:#2c2c2e;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;"
		);
		strip.append(chip);
	}
}

const bridge = window.ryuBrowser;
if (bridge) {
	bridge
		.list()
		.then(render)
		.catch(() => render([]));
	bridge.onTabs(render);
} else {
	render([]);
}
