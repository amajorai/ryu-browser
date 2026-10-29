import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { z } from "zod";
import {
	parseUpstreamProxy,
	resolvePinnedPublicAddress,
	startGuardedSocksProxy,
} from "./guarded-socks-proxy.ts";

const bufferSchema = z.instanceof(Buffer);

async function nextChunk(socket: Socket): Promise<Buffer> {
	return bufferSchema.parse((await once(socket, "data"))[0]);
}

describe("browser network guard", () => {
	test("pins a public DNS answer", async () => {
		await expect(
			resolvePinnedPublicAddress("example.com", async () => [
				{ address: "93.184.215.14", family: 4 },
			])
		).resolves.toEqual({ address: "93.184.215.14", family: 4 });
	});

	test("rejects mixed public and private DNS answers", async () => {
		await expect(
			resolvePinnedPublicAddress("example.com", async () => [
				{ address: "93.184.215.14", family: 4 },
				{ address: "127.0.0.1", family: 4 },
			])
		).rejects.toThrow("private or reserved");
	});

	test("rejects expanded IPv4-mapped loopback DNS answers", async () => {
		await expect(
			resolvePinnedPublicAddress("example.com", async () => [
				{ address: "0:0:0:0:0:ffff:7f00:1", family: 6 },
			])
		).rejects.toThrow("private or reserved");
	});

	test("rejects private literal and local hostname before resolution", async () => {
		await expect(
			resolvePinnedPublicAddress("127.0.0.1", async () => {
				throw new Error("resolver must not run");
			})
		).rejects.toThrow();
		await expect(
			resolvePinnedPublicAddress("localhost", async () => [
				{ address: "93.184.215.14", family: 4 },
			])
		).rejects.toThrow();
	});

	test("rejects a private SOCKS destination before connect", async () => {
		const proxy = await startGuardedSocksProxy();
		try {
			const client = connect(proxy.port, "127.0.0.1");
			await once(client, "connect");
			client.write(Buffer.from([5, 1, 0]));
			const method = z
				.instanceof(Buffer)
				.parse((await once(client, "data"))[0]);
			expect([...method]).toEqual([5, 0]);
			client.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]));
			const reply = z.instanceof(Buffer).parse((await once(client, "data"))[0]);
			expect(reply.subarray(0, 2)).toEqual(Buffer.from([5, 2]));
			client.destroy();
		} finally {
			proxy.close();
		}
	});

	test("accepts only a credentialed loopback upstream", () => {
		expect(parseUpstreamProxy(undefined)).toBeNull();
		expect(parseUpstreamProxy("socks5://ryu:s%40cret@127.0.0.1:4100")).toEqual({
			host: "127.0.0.1",
			password: "s@cret",
			port: 4100,
			username: "ryu",
		});
		// An older Core passes the manifest's unexpanded request through verbatim.
		const egressEnv = "RYU_EGRESS_PROXY_URL";
		for (const value of [`$\{${egressEnv}}`, ` $\{${egressEnv}} `]) {
			expect(parseUpstreamProxy(value)).toBeNull();
		}
		for (const value of [
			"socks5://127.0.0.1:4100",
			"socks5://ryu:pw@10.0.0.2:4100",
			"http://ryu:pw@127.0.0.1:4100",
			"socks5://ryu:pw@127.0.0.1",
		]) {
			expect(() => parseUpstreamProxy(value)).toThrow();
		}
	});

	test("forwards destinations by name through the authenticated upstream", async () => {
		const requests: string[] = [];
		const upstreamServer = createServer((socket) => {
			void (async () => {
				expect([...(await nextChunk(socket))]).toEqual([5, 1, 2]);
				socket.write(Buffer.from([5, 2]));
				const auth = await nextChunk(socket);
				expect(auth.subarray(2, 5).toString()).toBe("ryu");
				socket.write(Buffer.from([1, 0]));
				const request = await nextChunk(socket);
				const length = request[4] ?? 0;
				requests.push(
					`${request.subarray(5, 5 + length).toString()}:${request.readUInt16BE(5 + length)}`
				);
				socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
				socket.on("data", (chunk) => socket.write(chunk));
			})();
		});
		upstreamServer.listen(0, "127.0.0.1");
		await once(upstreamServer, "listening");
		const address = upstreamServer.address();
		if (!address || typeof address === "string") {
			throw new Error("upstream did not bind");
		}
		const proxy = await startGuardedSocksProxy({
			upstream: {
				host: "127.0.0.1",
				password: "pw",
				port: address.port,
				username: "ryu",
			},
		});
		try {
			const client = connect(proxy.port, "127.0.0.1");
			await once(client, "connect");
			client.write(Buffer.from([5, 1, 0]));
			expect([...(await nextChunk(client))]).toEqual([5, 0]);
			const host = Buffer.from("example.com");
			client.write(
				Buffer.concat([
					Buffer.from([5, 1, 0, 3, host.length]),
					host,
					Buffer.from([1, 187]),
				])
			);
			expect((await nextChunk(client))[1]).toBe(0);
			client.write("ping");
			expect((await nextChunk(client)).toString()).toBe("ping");
			expect(requests).toEqual(["example.com:443"]);
			client.destroy();
		} finally {
			proxy.close();
			upstreamServer.close();
		}
	});

	test("still refuses local destinations before reaching the upstream", async () => {
		const proxy = await startGuardedSocksProxy({
			upstream: { host: "127.0.0.1", password: "pw", port: 9, username: "ryu" },
		});
		try {
			const client = connect(proxy.port, "127.0.0.1");
			await once(client, "connect");
			client.write(Buffer.from([5, 1, 0]));
			await nextChunk(client);
			client.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]));
			expect((await nextChunk(client)).subarray(0, 2)).toEqual(
				Buffer.from([5, 2])
			);
			client.destroy();
		} finally {
			proxy.close();
		}
	});
});
