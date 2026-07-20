// Minimal preload for the Ryu Browser tab-strip renderer. Exposes a read-only
// tab snapshot channel over the context bridge — no privileged surface (the
// control server, not the renderer, is the automation seam).

import { contextBridge, ipcRenderer } from "electron";

interface TabInfo {
	id: string;
	url: string;
	title: string;
}

contextBridge.exposeInMainWorld("ryuBrowser", {
	list: (): Promise<TabInfo[]> => ipcRenderer.invoke("ryu-browser:list"),
	onTabs: (cb: (tabs: TabInfo[]) => void): void => {
		ipcRenderer.on("ryu-browser:tabs", (_e, tabs: TabInfo[]) => cb(tabs));
	},
});
