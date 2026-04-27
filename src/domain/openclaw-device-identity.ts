/**
 * Ed25519 device identity — aligned with OpenClaw Control UI
 * @see https://github.com/openclaw/openclaw/blob/main/ui/src/ui/device-identity.ts
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519"

export type StoredDeviceIdentity = {
  version: 1
  deviceId: string
  publicKey: string
  privateKey: string
  createdAtMs: number
}

export type DeviceIdentity = {
  deviceId: string
  publicKey: string
  privateKey: string
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

function base64UrlDecode(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"))
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function fingerprintPublicKey(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex")
}

export async function generateDeviceIdentity(): Promise<DeviceIdentity> {
  const privateKey = utils.randomSecretKey()
  const publicKey = await getPublicKeyAsync(privateKey)
  const deviceId = fingerprintPublicKey(publicKey)
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  }
}

/**
 * Load or create Ed25519 identity at `filePath` (public device id = SHA256(raw pubkey) hex).
 */
export async function loadOrCreateDeviceIdentity(filePath: string): Promise<DeviceIdentity> {
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")
      const parsed = JSON.parse(raw) as StoredDeviceIdentity
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKey === "string" &&
        typeof parsed.privateKey === "string"
      ) {
        const publicKey = base64UrlDecode(parsed.publicKey)
        const derivedId = fingerprintPublicKey(publicKey)
        if (derivedId !== parsed.deviceId) {
          const updated: StoredDeviceIdentity = { ...parsed, deviceId: derivedId, createdAtMs: parsed.createdAtMs }
          saveDeviceIdentityFile(filePath, updated)
          return { deviceId: derivedId, publicKey: parsed.publicKey, privateKey: parsed.privateKey }
        }
        return {
          deviceId: parsed.deviceId,
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
        }
      }
    }
  } catch {
    // create new
  }

  const identity = await generateDeviceIdentity()
  const stored: StoredDeviceIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  }
  saveDeviceIdentityFile(filePath, stored)
  return identity
}

function saveDeviceIdentityFile(filePath: string, data: StoredDeviceIdentity): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8")
}

export async function signDevicePayloadUtf8(payload: string, privateKeyBase64Url: string): Promise<string> {
  const key = base64UrlDecode(privateKeyBase64Url)
  const data = new TextEncoder().encode(payload)
  const sig = await signAsync(data, key)
  return base64UrlEncode(sig)
}
