import { afterEach, describe, expect, it } from "bun:test";
import { request, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { RequestDeps } from "./control-parsing.ts";
import { startControlServer } from "./control-server.ts";
import { EGRESS_ALLOWLIST_HEADER } from "./egress-allowlist.ts";

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createNetServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

function listening(server: Server): Promise<void> {
	return server.listening
		? Promise.resolve()
		: new Promise((resolve) => server.once("listening", () => resolve()));
}

function send(
	port: number,
	headers: Record<string, string | string[]>
): Promise<{ body: string; status: number }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				headers: { host: `127.0.0.1:${port}`, ...headers },
				hostname: "127.0.0.1",
				method: "GET",
				path: "/health?agent_id=bot-1",
				port,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						body: Buffer.concat(chunks).toString("utf8"),
						status: res.statusCode ?? 0,
					})
				);
			}
		);
		req.once("error", reject);
		req.end();
	});
}

describe("control server egress allowlist header", () => {
	let server: Server | undefined;
	const offered: (string | undefined)[] = [];

	afterEach(() => {
		server?.close();
		server = undefined;
		offered.length = 0;
	});

	async function start(): Promise<number> {
		const port = await freePort();
		const deps = {
			tabs: {},
			tabsFor: (_agentId: string, egressAllowlist?: string) => {
				offered.push(egressAllowlist);
				return null;
			},
			token: null,
		} as unknown as RequestDeps;
		server = startControlServer(deps, port);
		await listening(server);
		return port;
	}

	it("refuses a request that repeats the allowlist header", async () => {
		const port = await start();
		const res = await send(port, {
			[EGRESS_ALLOWLIST_HEADER]: ["example.com", "*.evil.example"],
			"x-ryu-caller-agent-id": "bot-1",
		});
		expect(res.status).toBe(403);
		expect(JSON.parse(res.body)).toEqual({
			error: "duplicate egress allowlist",
			ok: false,
		});
		expect(offered).toEqual([]);
	});

	it("still serves a request that carries the header once", async () => {
		const port = await start();
		const res = await send(port, {
			[EGRESS_ALLOWLIST_HEADER]: "example.com",
			"x-ryu-caller-agent-id": "bot-1",
		});
		expect(res.status).not.toBe(403);
	});
});
