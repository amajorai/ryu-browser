import { createPublicKey, type JsonWebKey } from "node:crypto";

/**
 * Best-effort reading of a registration's `attestationObject`, so the page's
 * `AuthenticatorAttestationResponse` can answer `getAuthenticatorData()`,
 * `getPublicKey()` and `getPublicKeyAlgorithm()` the way Chromium does. Sites
 * that only send `attestationObject` to their server never need it; anything
 * this cannot read is simply left out.
 */

export type CborValue =
	| number
	| bigint
	| string
	| boolean
	| null
	| undefined
	| Uint8Array
	| CborValue[]
	| Map<CborValue, CborValue>;

const MAX_DEPTH = 16;

class CborReader {
	constructor(
		private readonly bytes: Uint8Array,
		public offset = 0
	) {}

	private byte(): number {
		const value = this.bytes[this.offset];
		if (value === undefined) {
			throw new Error("truncated CBOR");
		}
		this.offset += 1;
		return value;
	}

	private length(info: number): number {
		if (info < 24) {
			return info;
		}
		const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
		const width = widths[info];
		if (width === undefined) {
			throw new Error("unsupported CBOR length");
		}
		let value = 0;
		for (let index = 0; index < width; index++) {
			value = value * 256 + this.byte();
		}
		if (!Number.isSafeInteger(value)) {
			throw new Error("CBOR length too large");
		}
		return value;
	}

	private take(count: number): Uint8Array {
		if (this.offset + count > this.bytes.length) {
			throw new Error("truncated CBOR");
		}
		const slice = this.bytes.slice(this.offset, this.offset + count);
		this.offset += count;
		return slice;
	}

	read(depth = 0): CborValue {
		if (depth > MAX_DEPTH) {
			throw new Error("CBOR nested too deeply");
		}
		const initial = this.byte();
		const major = initial >> 5;
		const info = initial & 0x1f;
		switch (major) {
			case 0:
				return this.length(info);
			case 1:
				return -1 - this.length(info);
			case 2:
				return this.take(this.length(info));
			case 3:
				return new TextDecoder().decode(this.take(this.length(info)));
			case 4: {
				const count = this.length(info);
				const items: CborValue[] = [];
				for (let index = 0; index < count; index++) {
					items.push(this.read(depth + 1));
				}
				return items;
			}
			case 5: {
				const count = this.length(info);
				const map = new Map<CborValue, CborValue>();
				for (let index = 0; index < count; index++) {
					const key = this.read(depth + 1);
					map.set(key, this.read(depth + 1));
				}
				return map;
			}
			case 6:
				this.length(info);
				return this.read(depth + 1);
			default:
				return this.simple(info);
		}
	}

	private simple(info: number): CborValue {
		if (info === 20) {
			return false;
		}
		if (info === 21) {
			return true;
		}
		if (info === 22) {
			return null;
		}
		if (info === 23) {
			return undefined;
		}
		const width = { 25: 2, 26: 4, 27: 8 }[info];
		if (width === undefined) {
			throw new Error("unsupported CBOR simple value");
		}
		const view = new DataView(this.take(width).buffer);
		if (width === 2) {
			return view.getUint16(0); // half floats never appear in WebAuthn data
		}
		return width === 4 ? view.getFloat32(0) : view.getFloat64(0);
	}
}

/** Decode one CBOR item and report where it ended. */
export function decodeCbor(
	bytes: Uint8Array,
	offset = 0
): { end: number; value: CborValue } {
	const reader = new CborReader(bytes, offset);
	const value = reader.read();
	return { end: reader.offset, value };
}

/** What `attestationObject` reveals about the new credential. */
export interface AttestationDetails {
	authenticatorData: Uint8Array;
	/** The new public key as DER SubjectPublicKeyInfo, when its type is known. */
	publicKey?: Uint8Array;
	/** COSE algorithm of the new key, when present. */
	publicKeyAlgorithm?: number;
}

const ATTESTED_CREDENTIAL_FLAG = 0x40;
/** rpIdHash (32) + flags (1) + signCount (4). */
const AUTH_DATA_HEADER = 37;
/** aaguid (16) + credentialIdLength (2). */
const ATTESTED_HEADER = 18;

const EC_CURVES: Record<number, string> = {
	1: "P-256",
	2: "P-384",
	3: "P-521",
};

function bytesAt(
	map: Map<CborValue, CborValue>,
	key: number
): Uint8Array | null {
	const value = map.get(key);
	return value instanceof Uint8Array ? value : null;
}

function b64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/** COSE_Key to JWK, for the key types security keys produce. */
export function coseKeyToJwk(
	key: Map<CborValue, CborValue>
): JsonWebKey | null {
	const kty = key.get(1);
	if (kty === 2) {
		const curve = EC_CURVES[Number(key.get(-1))];
		const x = bytesAt(key, -2);
		const y = bytesAt(key, -3);
		return curve && x && y
			? { crv: curve, kty: "EC", x: b64url(x), y: b64url(y) }
			: null;
	}
	if (kty === 1) {
		const x = bytesAt(key, -2);
		return key.get(-1) === 6 && x
			? { crv: "Ed25519", kty: "OKP", x: b64url(x) }
			: null;
	}
	if (kty === 3) {
		const n = bytesAt(key, -1);
		const e = bytesAt(key, -2);
		return n && e ? { e: b64url(e), kty: "RSA", n: b64url(n) } : null;
	}
	return null;
}

function publicKeyDetails(
	authData: Uint8Array
): Pick<AttestationDetails, "publicKey" | "publicKeyAlgorithm"> {
	const flags = authData[32] ?? 0;
	if ((flags & ATTESTED_CREDENTIAL_FLAG) === 0) {
		return {};
	}
	const idLengthAt = AUTH_DATA_HEADER + 16;
	if (authData.length < AUTH_DATA_HEADER + ATTESTED_HEADER) {
		return {};
	}
	const idLength =
		((authData[idLengthAt] ?? 0) << 8) | (authData[idLengthAt + 1] ?? 0);
	const keyAt = AUTH_DATA_HEADER + ATTESTED_HEADER + idLength;
	const { value } = decodeCbor(authData, keyAt);
	if (!(value instanceof Map)) {
		return {};
	}
	const alg = value.get(3);
	const details: Pick<AttestationDetails, "publicKey" | "publicKeyAlgorithm"> =
		typeof alg === "number" ? { publicKeyAlgorithm: alg } : {};
	const jwk = coseKeyToJwk(value);
	if (jwk) {
		const der = createPublicKey({ format: "jwk", key: jwk }).export({
			format: "der",
			type: "spki",
		});
		details.publicKey = new Uint8Array(der);
	}
	return details;
}

/** Read `authData` and the new key; null when the object cannot be read. */
export function readAttestationObject(
	attestationObject: Uint8Array
): AttestationDetails | null {
	try {
		const { value } = decodeCbor(attestationObject);
		if (!(value instanceof Map)) {
			return null;
		}
		const authData = value.get("authData");
		if (
			!(authData instanceof Uint8Array) ||
			authData.length < AUTH_DATA_HEADER
		) {
			return null;
		}
		let keyDetails: Pick<
			AttestationDetails,
			"publicKey" | "publicKeyAlgorithm"
		> = {};
		try {
			keyDetails = publicKeyDetails(authData);
		} catch {
			// An unreadable key still leaves the authenticator data usable.
		}
		return { authenticatorData: authData, ...keyDetails };
	} catch {
		return null;
	}
}
