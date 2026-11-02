import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readAttestationObject } from "./attestation.ts";
import type {
	RelayCredential,
	RelayOutcome,
	SecurityKeyClient,
} from "./client.ts";
import {
	createWebAuthnInitScript,
	WEBAUTHN_BINDING,
	webAuthnSettleExpression,
} from "./init-script.ts";
import {
	type BindingMessage,
	b64urlDecode,
	b64urlEncode,
	type CeremonyKind,
	type PageError,
	type PreparedRelay,
	parseBindingMessage,
	prepareRelay,
	RelayRefusal,
} from "./request.ts";

/** A CDP message listener, as `webContents.debugger` calls it. */
export type RelayMessageListener = (
	event: unknown,
	method: string,
	params: unknown
) => void;

/** The parts of Electron's `webContents` the bridge uses. */
export interface RelayContents {
	debugger: {
		on(event: "message", listener: RelayMessageListener): unknown;
		removeListener(event: "message", listener: RelayMessageListener): unknown;
		sendCommand(
			method: string,
			params?: Record<string, unknown>
		): Promise<unknown>;
	};
	getURL(): string;
	isDestroyed(): boolean;
	once(event: "destroyed", listener: () => void): unknown;
}

/** What the page-side shim receives through `__ryuWebAuthnSettle`. */
export type PageSettlement =
	| { fallback: true }
	| { error: PageError; ok: false }
	| { credential: PageCredential; ok: true };

export interface PageCredential {
	clientDataJSON: string;
	id: string;
	response:
		| {
				authenticatorData: string;
				kind: "assertion";
				signature: string;
				userHandle: string | null;
		  }
		| {
				attestationObject: string;
				authenticatorData?: string;
				kind: "attestation";
				publicKey?: string;
				publicKeyAlgorithm?: number;
				transports: string[];
		  };
}

const contextCreatedSchema = z.object({
	context: z.object({
		auxData: z.object({ frameId: z.string(), isDefault: z.literal(true) }),
		id: z.number().int(),
	}),
});
const contextDestroyedSchema = z.object({
	executionContextId: z.number().int(),
});
const frameNavigatedSchema = z.object({
	frame: z.object({ id: z.string(), parentId: z.string().optional() }),
});
const bindingCalledSchema = z.object({
	executionContextId: z.number().int(),
	name: z.literal(WEBAUTHN_BINDING),
	payload: z.string(),
});
const frameTreeSchema = z.object({
	frameTree: z.object({ frame: z.object({ id: z.string() }) }),
});

function refused(name: PageError["name"], message: string): PageSettlement {
	return { error: { message, name }, ok: false };
}

const BUSY = refused(
	"NotAllowedError",
	"Another security key request is already in progress in this tab."
);

function pageCredential(
	credential: RelayCredential,
	clientDataJSON: string
): PageCredential | null {
	const id = b64urlDecode(credential.id);
	if (!id || id.length === 0) {
		return null;
	}
	const response = credential.response;
	if (response.kind === "assertion") {
		return {
			clientDataJSON,
			id: b64urlEncode(id),
			response: {
				authenticatorData: response.authenticator_data,
				kind: "assertion",
				signature: response.signature,
				userHandle: response.user_handle ?? null,
			},
		};
	}
	const attestation = b64urlDecode(response.attestation_object);
	if (!attestation) {
		return null;
	}
	const details = readAttestationObject(attestation);
	return {
		clientDataJSON,
		id: b64urlEncode(id),
		response: {
			attestationObject: response.attestation_object,
			kind: "attestation",
			transports: response.transports,
			...(details
				? {
						authenticatorData: b64urlEncode(details.authenticatorData),
						...(details.publicKey
							? { publicKey: b64urlEncode(details.publicKey) }
							: {}),
						...(details.publicKeyAlgorithm === undefined
							? {}
							: { publicKeyAlgorithm: details.publicKeyAlgorithm }),
					}
				: {}),
		},
	};
}

/**
 * Map Core's outcome onto what the page receives. `disabled` on the visible
 * lane falls back to Chromium's own WebAuthn (the behaviour before the relay
 * existed); a hidden Bot lane never raises a native prompt.
 */
export function settlementFor(
	outcome: RelayOutcome,
	kind: CeremonyKind,
	prepared: PreparedRelay,
	visibleLane: boolean
): PageSettlement {
	switch (outcome.status) {
		case "ok": {
			const expected = kind === "get" ? "assertion" : "attestation";
			const credential =
				outcome.credential.response.kind === expected
					? pageCredential(outcome.credential, prepared.clientDataJSON)
					: null;
			return credential
				? { credential, ok: true }
				: refused(
						"NotAllowedError",
						"The security key returned an unusable credential."
					);
		}
		case "disabled":
			return visibleLane
				? { fallback: true }
				: refused(
						"NotAllowedError",
						"Hardware security keys are turned off for this browser."
					);
		case "timeout":
			return refused("NotAllowedError", "The security key request timed out.");
		case "invalid":
			return refused(
				"NotAllowedError",
				"The security key request was not valid."
			);
		default:
			return refused(
				"NotAllowedError",
				"The security key request was not allowed."
			);
	}
}

interface InFlight {
	contextId: number;
	controller: AbortController;
	requestId: number;
}

/**
 * One tab's WebAuthn relay. It installs the page shim and its private
 * binding, accepts binding calls only from the top frame's default context
 * with this tab's capability, runs at most one ceremony at a time, and cancels
 * it when the top frame navigates, its context goes away, or the tab closes.
 */
export class WebAuthnBridge {
	private readonly contexts = new Map<number, string>();
	private topFrameId: string | null = null;
	private inFlight: InFlight | null = null;
	private disposed = false;
	private readonly listener: RelayMessageListener = (
		_event,
		method,
		params
	) => {
		void this.handleMessage(method, params);
	};

	constructor(
		private readonly contents: RelayContents,
		private readonly client: SecurityKeyClient,
		/** The Bot lane, or null for the user's visible lane. */
		readonly agentId: string | null,
		private readonly capability: string = randomUUID()
	) {}

	/** Attach the shim; resolves before the tab's first real navigation. */
	async install(): Promise<void> {
		const debuggerSession = this.contents.debugger;
		debuggerSession.on("message", this.listener);
		this.contents.once("destroyed", () => this.dispose());
		await debuggerSession.sendCommand("Runtime.enable");
		await debuggerSession.sendCommand("Page.enable");
		await debuggerSession.sendCommand("Runtime.addBinding", {
			name: WEBAUTHN_BINDING,
		});
		const tree = frameTreeSchema.safeParse(
			await debuggerSession.sendCommand("Page.getFrameTree")
		);
		if (tree.success) {
			this.topFrameId = tree.data.frameTree.frame.id;
		}
		await debuggerSession.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
			source: createWebAuthnInitScript(this.capability),
		});
	}

	/** Stop listening and abandon any ceremony in flight. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.cancel();
		try {
			this.contents.debugger.removeListener("message", this.listener);
		} catch {
			// The contents are already gone.
		}
	}

	/** Whether a ceremony is waiting on Core (for tests and diagnostics). */
	get busy(): boolean {
		return this.inFlight !== null;
	}

	private cancel(): void {
		const flight = this.inFlight;
		this.inFlight = null;
		flight?.controller.abort();
	}

	/** Handle one CDP event; resolves when any ceremony it started ends. */
	handleMessage(method: string, params: unknown): Promise<void> | undefined {
		if (this.disposed) {
			return;
		}
		switch (method) {
			case "Runtime.executionContextCreated": {
				const created = contextCreatedSchema.safeParse(params);
				if (created.success) {
					this.contexts.set(
						created.data.context.id,
						created.data.context.auxData.frameId
					);
				}
				return;
			}
			case "Runtime.executionContextDestroyed": {
				const destroyed = contextDestroyedSchema.safeParse(params);
				if (destroyed.success) {
					this.contexts.delete(destroyed.data.executionContextId);
					if (this.inFlight?.contextId === destroyed.data.executionContextId) {
						this.cancel();
					}
				}
				return;
			}
			case "Runtime.executionContextsCleared":
				this.contexts.clear();
				this.cancel();
				return;
			case "Page.frameNavigated": {
				const navigated = frameNavigatedSchema.safeParse(params);
				if (navigated.success && navigated.data.frame.parentId === undefined) {
					this.topFrameId = navigated.data.frame.id;
					this.cancel();
				}
				return;
			}
			case "Runtime.bindingCalled":
				return this.bindingCalled(params);
			default:
				return;
		}
	}

	private bindingCalled(params: unknown): Promise<void> | undefined {
		const call = bindingCalledSchema.safeParse(params);
		if (!call.success) {
			return;
		}
		const contextId = call.data.executionContextId;
		const frameId = this.contexts.get(contextId);
		if (frameId === undefined || frameId !== this.topFrameId) {
			return;
		}
		const message = parseBindingMessage(call.data.payload);
		if (!message || message.capability !== this.capability) {
			return;
		}
		if (message.action === "cancel") {
			if (
				this.inFlight?.requestId === message.requestId &&
				this.inFlight.contextId === contextId
			) {
				this.cancel();
			}
			return;
		}
		return this.ceremony(contextId, message);
	}

	private async ceremony(
		contextId: number,
		message: Extract<BindingMessage, { action: "request" }>
	): Promise<void> {
		const settle = (settlement: PageSettlement) =>
			this.settle(contextId, message.requestId, settlement);
		if (this.inFlight) {
			await settle(BUSY);
			return;
		}
		const pageUrl = this.contents.getURL();
		let prepared: PreparedRelay;
		try {
			prepared = prepareRelay({
				agentId: this.agentId,
				kind: message.kind,
				options: message.options,
				pageUrl,
			});
		} catch (error) {
			await settle(
				error instanceof RelayRefusal
					? refused(error.page, error.message)
					: refused(
							"NotAllowedError",
							"The security key request was not allowed."
						)
			);
			return;
		}
		const flight: InFlight = {
			contextId,
			controller: new AbortController(),
			requestId: message.requestId,
		};
		this.inFlight = flight;
		let outcome: RelayOutcome;
		try {
			outcome = await this.client.request(
				prepared.request,
				flight.controller.signal
			);
		} finally {
			if (this.inFlight === flight) {
				this.inFlight = null;
			}
		}
		const stale =
			flight.controller.signal.aborted ||
			this.disposed ||
			this.contents.isDestroyed() ||
			this.contents.getURL() !== pageUrl ||
			!this.contexts.has(contextId);
		if (stale) {
			return;
		}
		await settle(
			settlementFor(outcome, message.kind, prepared, this.agentId === null)
		);
	}

	private async settle(
		contextId: number,
		requestId: number,
		settlement: PageSettlement
	): Promise<void> {
		if (this.disposed || this.contents.isDestroyed()) {
			return;
		}
		try {
			await this.contents.debugger.sendCommand("Runtime.evaluate", {
				contextId,
				expression: webAuthnSettleExpression(
					this.capability,
					requestId,
					settlement
				),
				returnByValue: true,
			});
		} catch {
			// The document went away; its promise went with it.
		}
	}
}
