import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { connect, createServer, isIP, type Socket } from "node:net";
import { z } from "zod";
import { blockedNavigationAddress, safeNavigationUrl } from "./control.ts";

interface ResolvedAddress {
	address: string;
	family: number;
}
type Resolver = (host: string) => Promise<ResolvedAddress[]>;

const MAX_HANDSHAKE_BYTES = 1024;
const pinnedAddressFieldsSchema = z.object({
	address: z.string(),
	family: z.union([z.literal(4), z.literal(6)]),
});
const pinnedAddressSchema = z.custom<
	z.output<typeof pinnedAddressFieldsSchema>
>((value) => pinnedAddressFieldsSchema.safeParse(value).success);
type PinnedPublicAddress = z.output<typeof pinnedAddressSchema>;
const boundAddressSchema = z.object({
	address: z.string(),
	family: z.string(),
	port: z.number(),
});

/** Screen the exact DNS answers used by the socket, then return one pinned IP. */
export async function resolvePinnedPublicAddress(
	host: string,
	resolve: Resolver = (name) => lookup(name, { all: true, verbatim: true })
): Promise<PinnedPublicAddress> {
	const urlHost = isIP(host) === 6 ? `[${host}]` : host;
	const parsed = new URL(safeNavigationUrl(`http://${urlHost}/`));
	const normalized = parsed.hostname.replace(/^\[|\]$/g, "");
	const literalFamily = isIP(normalized);
	const answers = literalFamily
		? [{ address: normalized, family: literalFamily }]
		: await resolve(normalized);
	if (
		answers.length === 0 ||
		answers.some(
			(answer) =>
				(answer.family !== 4 && answer.family !== 6) ||
				isIP(answer.address) !== answer.family ||
				blockedNavigationAddress(
					answer.family === 6
						? new URL(`http://[${answer.address}]/`).hostname.slice(1, -1)
						: answer.address
				)
		)
	) {
		throw new Error(
			"browser destination resolves to a private or reserved address"
		);
	}
	return pinnedAddressSchema.parse(answers[0]);
}

/**
 * Core's credentialed node proxy. When present, every browser connection is
 * forwarded through it by hostname, so Core decides whether traffic leaves
 * from the cloud or through the user's desktop ("Route traffic through this
 * computer") and screens the destination where it is actually resolved.
 */
export interface UpstreamProxy {
	host: string;
	password: string;
	port: number;
	username: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * The manifest's unexpanded request for the egress URL. A Core that predates
 * that request passes the literal `${RYU_EGRESS_PROXY_URL}` through, which
 * means "no egress route", not a malformed proxy that should stop the browser.
 */
const UNEXPANDED_PLACEHOLDER = /^\$\{[A-Z0-9_]+\}$/;

/** Parse `socks5://user:pass@127.0.0.1:port`; anything else fails closed. */
export function parseUpstreamProxy(
	value: string | undefined
): UpstreamProxy | null {
	const trimmed = value?.trim();
	if (!trimmed || UNEXPANDED_PLACEHOLDER.test(trimmed)) {
		return null;
	}
	const parsed = new URL(trimmed);
	const port = Number(parsed.port);
	if (
		parsed.protocol !== "socks5:" ||
		!LOOPBACK_HOSTS.has(parsed.hostname) ||
		!Number.isInteger(port) ||
		port <= 0 ||
		port > 65_535 ||
		!parsed.username ||
		!parsed.password
	) {
		throw new Error("browser egress proxy must be a loopback socks5 URL");
	}
	return {
		host: parsed.hostname.replace(/^\[|\]$/g, ""),
		password: decodeURIComponent(parsed.password),
		port,
		username: decodeURIComponent(parsed.username),
	};
}

async function readExact(socket: Socket, length: number): Promise<Buffer> {
	for (;;) {
		const chunk: unknown = socket.read(length);
		if (chunk instanceof Buffer) {
			return chunk;
		}
		if (socket.readableEnded || socket.destroyed) {
			throw new Error("browser egress proxy closed the connection");
		}
		await once(socket, "readable");
	}
}

/** Every destination is sent by name (ATYP 3); Core resolves and screens it. */
function socksAddress(host: string): Buffer {
	const name = Buffer.from(host, "utf8");
	if (name.length === 0 || name.length > 255) {
		throw new Error("invalid destination host");
	}
	return Buffer.concat([Buffer.from([3, name.length]), name]);
}

/** Open `host:port` through Core's proxy using SOCKS5 username/password. */
export async function connectThroughUpstream(
	upstream: UpstreamProxy,
	host: string,
	port: number
): Promise<Socket> {
	const socket = connect({ host: upstream.host, port: upstream.port });
	socket.setTimeout(15_000, () => socket.destroy());
	try {
		await once(socket, "connect");
		socket.write(Buffer.from([5, 1, 2]));
		const method = await readExact(socket, 2);
		if (method[0] !== 5 || method[1] !== 2) {
			throw new Error("browser egress proxy refused authentication");
		}
		const user = Buffer.from(upstream.username, "utf8");
		const pass = Buffer.from(upstream.password, "utf8");
		socket.write(
			Buffer.concat([
				Buffer.from([1, user.length]),
				user,
				Buffer.from([pass.length]),
				pass,
			])
		);
		const auth = await readExact(socket, 2);
		if (auth[1] !== 0) {
			throw new Error("browser egress proxy rejected its credential");
		}
		const portBytes = Buffer.alloc(2);
		portBytes.writeUInt16BE(port);
		socket.write(
			Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(host), portBytes])
		);
		const reply = await readExact(socket, 4);
		if (reply[1] !== 0) {
			throw new Error("browser egress proxy could not reach the destination");
		}
		const addressLength =
			reply[3] === 1
				? 4
				: reply[3] === 4
					? 16
					: ((await readExact(socket, 1))[0] ?? 0);
		await readExact(socket, addressLength + 2);
		socket.setTimeout(0);
		return socket;
	} catch (error) {
		socket.destroy();
		throw error;
	}
}

/** Reject obviously local destinations before handing a hostname upstream. */
function screenUpstreamHost(host: string): void {
	const urlHost = isIP(host) === 6 ? `[${host}]` : host;
	safeNavigationUrl(`http://${urlHost}/`);
}

function socksReply(socket: Socket, code: number): void {
	socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function parseDestination(
	buffer: Buffer
): { host: string; port: number; remaining: Buffer } | null {
	if (buffer.length < 4) {
		return null;
	}
	if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) {
		throw new Error("unsupported SOCKS request");
	}
	const atyp = buffer[3];
	let offset = 4;
	let host: string;
	if (atyp === 1) {
		if (buffer.length < offset + 4 + 2) {
			return null;
		}
		host = [...buffer.subarray(offset, offset + 4)].join(".");
		offset += 4;
	} else if (atyp === 3) {
		if (buffer.length < offset + 1) {
			return null;
		}
		const length = buffer[offset] ?? 0;
		offset += 1;
		if (length === 0) {
			throw new Error("empty SOCKS host");
		}
		if (buffer.length < offset + length + 2) {
			return null;
		}
		host = buffer.subarray(offset, offset + length).toString("utf8");
		offset += length;
	} else if (atyp === 4) {
		if (buffer.length < offset + 16 + 2) {
			return null;
		}
		const words: string[] = [];
		for (let i = 0; i < 16; i += 2) {
			words.push(buffer.readUInt16BE(offset + i).toString(16));
		}
		host = words.join(":");
		offset += 16;
	} else {
		throw new Error("unsupported SOCKS address type");
	}
	const port = buffer.readUInt16BE(offset);
	if (port === 0) {
		throw new Error("invalid destination port");
	}
	return { host, port, remaining: buffer.subarray(offset + 2) };
}

function handleClient(
	client: Socket,
	resolve: Resolver,
	upstreamProxy: UpstreamProxy | null
): void {
	let buffer = Buffer.alloc(0);
	let phase: "methods" | "request" | "connecting" = "methods";
	client.setTimeout(10_000, () => client.destroy());
	const onData = (chunk: Buffer) => {
		if (buffer.length + chunk.length > MAX_HANDSHAKE_BYTES) {
			client.destroy();
			return;
		}
		buffer = Buffer.concat([buffer, chunk]);
		if (phase === "methods") {
			if (buffer.length < 2) {
				return;
			}
			const count = buffer[1] ?? 0;
			if (buffer.length < 2 + count) {
				return;
			}
			if (buffer[0] !== 5 || !buffer.subarray(2, 2 + count).includes(0)) {
				client.end(Buffer.from([5, 255]));
				return;
			}
			client.write(Buffer.from([5, 0]));
			buffer = buffer.subarray(2 + count);
			phase = "request";
		}
		if (phase !== "request") {
			return;
		}
		let destination;
		try {
			destination = parseDestination(buffer);
		} catch {
			socksReply(client, 7);
			client.end();
			return;
		}
		if (!destination) {
			return;
		}
		phase = "connecting";
		client.pause();
		client.off("data", onData);
		void (async () => {
			let upstream: Socket | null = null;
			try {
				if (upstreamProxy) {
					screenUpstreamHost(destination.host);
					upstream = await connectThroughUpstream(
						upstreamProxy,
						destination.host,
						destination.port
					);
				} else {
					const pinned = await resolvePinnedPublicAddress(
						destination.host,
						resolve
					);
					if (client.destroyed) {
						return;
					}
					upstream = connect({
						host: pinned.address,
						family: pinned.family,
						port: destination.port,
					});
					upstream.setTimeout(10_000, () => upstream?.destroy());
					await once(upstream, "connect");
				}
				if (client.destroyed) {
					upstream.destroy();
					return;
				}
				upstream.setTimeout(0);
				client.setTimeout(0);
				socksReply(client, 0);
				if (destination.remaining.length) {
					upstream.write(destination.remaining);
				}
				client.pipe(upstream);
				upstream.pipe(client);
				upstream.on("error", () => client.destroy());
				client.on("close", () => upstream?.destroy());
				client.resume();
			} catch {
				socksReply(client, 2);
				client.end();
				upstream?.destroy();
			}
		})();
	};
	client.on("data", onData);
	client.on("error", () => client.destroy());
}

/**
 * One fail-closed local proxy for every managed and visible Chromium tab. With
 * an `upstream`, connections are forwarded through Core's node proxy instead of
 * being dialed directly.
 */
export async function startGuardedSocksProxy(
	options: { upstream?: UpstreamProxy | null } = {}
): Promise<{
	close: () => void;
	port: number;
}> {
	const upstream = options.upstream ?? null;
	const server = createServer((client) =>
		handleClient(
			client,
			(name) => lookup(name, { all: true, verbatim: true }),
			upstream
		)
	);
	server.maxConnections = 256;
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = boundAddressSchema.safeParse(server.address());
	if (!address.success) {
		server.close();
		throw new Error("browser network guard could not bind");
	}
	return { close: () => server.close(), port: address.data.port };
}
