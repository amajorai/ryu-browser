// Adapts one Electron tab's contents to the live view's `LiveViewSource`.
//
// The screencast runs on the tab's existing in-process debugger session (the
// same one the control surface uses; no remote debugging port is opened). The
// capture fallback keeps a hidden Bot window hidden (`stayHidden`).

import type { WebContents } from "electron";
import type { LiveViewImage, LiveViewSource } from "./bot-live-view.ts";
import { CDP_PROTOCOL_VERSION } from "./tab-support.ts";

/** JPEG quality of a capture taken when the screencast has no fresh frame. */
export const LIVE_VIEW_CAPTURE_QUALITY = 60;

export function liveViewSourceFor(contents: WebContents): LiveViewSource {
	return {
		capture: async (): Promise<LiveViewImage | null> => {
			if (contents.isDestroyed()) {
				return null;
			}
			const image = await contents.capturePage(undefined, {
				stayHidden: true,
			});
			const size = image.getSize();
			if (size.width === 0 || size.height === 0) {
				return null;
			}
			return {
				height: size.height,
				image: image.toJPEG(LIVE_VIEW_CAPTURE_QUALITY).toString("base64"),
				width: size.width,
			};
		},
		onMessage: (listener) => {
			const handler = (
				_event: Electron.Event,
				method: string,
				params: unknown
			) => listener(method, params);
			contents.debugger.on("message", handler);
			return () => {
				contents.debugger.removeListener("message", handler);
			};
		},
		send: (method, params) => {
			if (contents.isDestroyed()) {
				return Promise.reject(new Error("the tab is closed"));
			}
			const session = contents.debugger;
			if (!session.isAttached()) {
				session.attach(CDP_PROTOCOL_VERSION);
			}
			return session.sendCommand(method, params);
		},
	};
}
