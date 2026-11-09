import { createServer, type Server } from "node:http";
import { z } from "zod";
import { handleRequest } from "./control.ts";
import type { RequestDeps } from "./control-parsing.ts";
import { browserControlString } from "./control-records.ts";
import {
	EGRESS_ALLOWLIST_HEADER,
	egressAllowlistHeaderCount,
} from "./egress-allowlist.ts";
import {
	agentLaneForCaller,
	bodyWithinControlLimit,
	isTrustedLocalRequest,
} from "./navigation-safety.ts";

/**
 * Start the loopback control server. Best-effort like the island's: a bind failure
 * (stale instance on the port) logs and leaves the app running rather than crashing.
 */
export function startControlServer(deps: RequestDeps, port: number): Server {
	const server = createServer((req, res) => {
		// Loopback-only is not enough: any web page can POST here (CSRF via
		// CORS-safelisted content types) and a DNS-rebound page can read state.
		// Reject anything that is not a plain local-process request BEFORE routing
		// (this also shields the unauthenticated `GET /health`).
		if (!isTrustedLocalRequest(req, port)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "forbidden" }));
			return;
		}
		// Node joins repeated custom headers with ", ", so a second copy of the
		// allowlist would silently merge into one wider list. Refuse it instead.
		if (egressAllowlistHeaderCount(req.rawHeaders) > 1) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({ ok: false, error: "duplicate egress allowlist" })
			);
			req.resume();
			return;
		}
		const declaredLength = Number(req.headers["content-length"]);
		if (
			Number.isFinite(declaredLength) &&
			declaredLength >= 0 &&
			!bodyWithinControlLimit(declaredLength)
		) {
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({ ok: false, error: "request body is too large" })
			);
			req.resume();
			return;
		}
		const chunks: Buffer[] = [];
		let bodyBytes = 0;
		let tooLarge = false;
		req.on("data", (c) => {
			if (tooLarge) {
				return;
			}
			const chunk = z.instanceof(Buffer).parse(c);
			bodyBytes += chunk.length;
			if (!bodyWithinControlLimit(bodyBytes)) {
				tooLarge = true;
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({ ok: false, error: "request body is too large" })
				);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (tooLarge) {
				return;
			}
			const body = Buffer.concat(chunks).toString("utf8");
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const agentIds = url.searchParams.getAll("agent_id");
			if (agentIds.length > 1) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: "duplicate agent_id" }));
				return;
			}
			const lane = agentLaneForCaller(
				agentIds[0],
				browserControlString(req.headers["x-ryu-caller-agent-id"]),
				browserControlString(req.headers["x-ryu-caller-user-id"])
			);
			handleRequest(
				req.method ?? "GET",
				url.pathname,
				req.headers.authorization,
				body,
				deps,
				req.headers["content-type"],
				lane,
				// Only a Core-verified agent lane may carry an allowlist.
				lane === undefined
					? undefined
					: browserControlString(req.headers[EGRESS_ALLOWLIST_HEADER])
			)
				.then((resp) => {
					if (resp.raw) {
						res.writeHead(resp.status, {
							"Content-Type": resp.raw.contentType,
						});
						res.end(resp.raw.body);
						return;
					}
					res.writeHead(resp.status, { "Content-Type": "application/json" });
					res.end(JSON.stringify(resp.json ?? {}));
				})
				.catch((e) => {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							ok: false,
							error: e instanceof Error ? e.message : "error",
						})
					);
				});
		});
	});
	server.on("error", (err) => {
		console.warn(`[ryu-browser] control server unavailable: ${err.message}`);
	});
	server.listen(port, "127.0.0.1");
	return server;
}
