import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
	type CborValue,
	coseKeyToJwk,
	decodeCbor,
	readAttestationObject,
} from "./attestation.ts";

type Encodable =
	| number
	| string
	| Uint8Array
	| Encodable[]
	| Map<Encodable, Encodable>;

function head(major: number, length: number): number[] {
	if (length < 24) {
		return [(major << 5) | length];
	}
	if (length < 256) {
		return [(major << 5) | 24, length];
	}
	return [(major << 5) | 25, length >> 8, length & 0xff];
}

/** Minimal canonical CBOR encoder for fixtures. */
function cbor(value: Encodable): number[] {
	if (typeof value === "number") {
		return value >= 0 ? head(0, value) : head(1, -1 - value);
	}
	if (typeof value === "string") {
		const bytes = [...new TextEncoder().encode(value)];
		return [...head(3, bytes.length), ...bytes];
	}
	if (value instanceof Uint8Array) {
		return [...head(2, value.length), ...value];
	}
	if (Array.isArray(value)) {
		return [...head(4, value.length), ...value.flatMap(cbor)];
	}
	return [
		...head(5, value.size),
		...[...value].flatMap(([k, v]) => [...cbor(k), ...cbor(v)]),
	];
}

function fromB64url(text: string | undefined): Uint8Array {
	return new Uint8Array(Buffer.from(text ?? "", "base64url"));
}

function attestationFixture(coseKey: Map<Encodable, Encodable>, flags = 0x41) {
	const credentialId = Uint8Array.from([9, 8, 7, 6]);
	const authData = Uint8Array.from([
		...new Uint8Array(32).fill(0xaa),
		flags,
		0,
		0,
		0,
		5,
		...new Uint8Array(16),
		0,
		credentialId.length,
		...credentialId,
		...cbor(coseKey),
	]);
	const object = new Map<Encodable, Encodable>([
		["fmt", "none"],
		["attStmt", new Map()],
		["authData", authData],
	]);
	return { authData, object: Uint8Array.from(cbor(object)) };
}

describe("decodeCbor", () => {
	it("decodes integers, strings, bytes, arrays, maps, and simple values", () => {
		expect(decodeCbor(Uint8Array.from([0x18, 0x64])).value).toBe(100);
		expect(decodeCbor(Uint8Array.from([0x26])).value).toBe(-7);
		expect(decodeCbor(Uint8Array.from([0x63, 0x66, 0x6d, 0x74])).value).toBe(
			"fmt"
		);
		expect(decodeCbor(Uint8Array.from([0x82, 0xf5, 0xf6])).value).toEqual([
			true,
			null,
		]);
		const decoded = decodeCbor(
			Uint8Array.from([0xa1, 0x01, 0x42, 0x01, 0x02, 0xff])
		);
		expect(decoded.end).toBe(5);
		expect(decoded.value).toEqual(new Map([[1, Uint8Array.from([1, 2])]]));
	});

	it("throws on truncated input", () => {
		expect(() => decodeCbor(Uint8Array.from([0x42, 0x01]))).toThrow(
			"truncated"
		);
	});
});

describe("readAttestationObject", () => {
	it("reads authData and turns an EC2 P-256 COSE key into SPKI", () => {
		const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const jwk = publicKey.export({ format: "jwk" });
		const cose = new Map<Encodable, Encodable>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, fromB64url(jwk.x)],
			[-3, fromB64url(jwk.y)],
		]);
		const { authData, object } = attestationFixture(cose);
		const details = readAttestationObject(object);
		expect(details?.authenticatorData).toEqual(authData);
		expect(details?.publicKeyAlgorithm).toBe(-7);
		expect(Buffer.from(details?.publicKey ?? [])).toEqual(
			publicKey.export({ format: "der", type: "spki" })
		);
	});

	it("handles Ed25519 keys", () => {
		const { publicKey } = generateKeyPairSync("ed25519");
		const jwk = publicKey.export({ format: "jwk" });
		const cose = new Map<Encodable, Encodable>([
			[1, 1],
			[3, -8],
			[-1, 6],
			[-2, fromB64url(jwk.x)],
		]);
		const details = readAttestationObject(attestationFixture(cose).object);
		expect(details?.publicKeyAlgorithm).toBe(-8);
		expect(Buffer.from(details?.publicKey ?? [])).toEqual(
			publicKey.export({ format: "der", type: "spki" })
		);
	});

	it("keeps authData when the key type is unknown or no credential is attested", () => {
		const unknown = readAttestationObject(
			attestationFixture(
				new Map<Encodable, Encodable>([
					[1, 99],
					[3, -65_535],
				])
			).object
		);
		expect(unknown?.publicKeyAlgorithm).toBe(-65_535);
		expect(unknown?.publicKey).toBeUndefined();
		const noCredential = readAttestationObject(
			attestationFixture(new Map(), 0x01).object
		);
		expect(noCredential?.authenticatorData.length).toBeGreaterThan(37);
		expect(noCredential?.publicKey).toBeUndefined();
	});

	it("returns null for anything that is not an attestation object", () => {
		expect(readAttestationObject(Uint8Array.from([0x01]))).toBeNull();
		expect(
			readAttestationObject(Uint8Array.from(cbor(new Map([["fmt", "none"]]))))
		).toBeNull();
		expect(readAttestationObject(Uint8Array.from([0xa1]))).toBeNull();
	});
});

describe("coseKeyToJwk", () => {
	it("maps RSA keys and rejects incomplete ones", () => {
		expect(
			coseKeyToJwk(
				new Map<CborValue, CborValue>([
					[1, 3],
					[-1, Uint8Array.from([1])],
					[-2, Uint8Array.from([1, 0, 1])],
				])
			)
		).toEqual({ e: "AQAB", kty: "RSA", n: "AQ" });
		expect(coseKeyToJwk(new Map<CborValue, CborValue>([[1, 2]]))).toBeNull();
	});
});
