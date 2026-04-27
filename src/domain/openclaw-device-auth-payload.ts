/**
 * Matches OpenClaw `src/gateway/device-auth.ts` (pipe-delimited signed payloads).
 * @see https://github.com/openclaw/openclaw/blob/main/src/gateway/device-auth.ts
 */
export type DeviceAuthPayloadParams = {
  deviceId: string
  clientId: string
  clientMode: string
  role: string
  scopes: string[]
  signedAtMs: number
  token?: string | null
  nonce: string
}

export type DeviceAuthPayloadV3Params = DeviceAuthPayloadParams & {
  platform?: string | null
  deviceFamily?: string | null
}

function normalizeDeviceMetadataForAuth(value?: string | null): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  if (!trimmed) return ""
  return trimmed.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32))
}

export function buildDeviceAuthPayloadV2(params: DeviceAuthPayloadParams): string {
  const scopes = params.scopes.join(",")
  const token = params.token ?? ""
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
  ].join("|")
}

export function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
  const scopes = params.scopes.join(",")
  const token = params.token ?? ""
  const platform = normalizeDeviceMetadataForAuth(params.platform)
  const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily)
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|")
}
