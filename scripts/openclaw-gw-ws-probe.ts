/**
 * Smoke-test OpenClaw Gateway WS + device auth (Path B): connect with Ed25519, then agents.list + tools.catalog.
 *
 * Requires: OPENCLAW_GATEWAY_TOKEN, optional OPENCLAW_WS_URL / OPENCLAW_DEVICE_*_PATH
 *
 * Run: npx tsx scripts/openclaw-gw-ws-probe.ts
 */
import { resolve } from "node:path"
import "dotenv/config"
import {
  OpenClawGatewayPairingRequiredError,
  openClawHttpToWsBase,
  probeOpenClawGatewayOperator,
} from "../src/domain/openclaw-gateway-ws.js"

function wsUrlFromEnv(): string {
  if (process.env.OPENCLAW_WS_URL?.trim()) {
    return process.env.OPENCLAW_WS_URL.trim()
  }
  const base = process.env.OPENCLAW_BASE_URL ?? "http://127.0.0.1:18789"
  return openClawHttpToWsBase(base)
}

async function main(): Promise<void> {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim()
  if (!token) {
    console.error("Set OPENCLAW_GATEWAY_TOKEN to the Gateway shared token (same as gateway.auth.token).")
    process.exit(1)
  }

  const wsUrl = wsUrlFromEnv()
  const deviceIdentityPath =
    process.env.OPENCLAW_DEVICE_IDENTITY_PATH?.trim() ??
    resolve(process.cwd(), ".data", "openclaw-device-identity.json")
  const deviceTokenPath =
    process.env.OPENCLAW_DEVICE_TOKEN_PATH?.trim() ??
    resolve(process.cwd(), ".data", "openclaw-device-token.json")

  console.log("Probing OpenClaw Gateway WS", { wsUrl, deviceIdentityPath, deviceTokenPath })

  const useAuthV3 = process.env.OPENCLAW_DEVICE_AUTH_V3 === "1" || process.env.OPENCLAW_DEVICE_AUTH_V3 === "true"

  const result = await probeOpenClawGatewayOperator({
    wsUrl,
    gatewayToken: token,
    deviceIdentityPath,
    deviceTokenPath,
    useAuthV3,
  })

  console.log(JSON.stringify({ ok: true, deviceTokenSaved: Boolean(result.deviceToken), summary: "agents + tools received" }, null, 2))
  console.log("agents.list (truncated):", JSON.stringify(result.agents).slice(0, 2000))
  console.log("tools.catalog (truncated):", JSON.stringify(result.tools).slice(0, 2000))
}

main().catch((err) => {
  if (err instanceof OpenClawGatewayPairingRequiredError) {
    console.error("Device auth OK, but the Gateway has not approved this device yet (Path B: pairing).")
    console.error("  requestId:", err.requestId)
    console.error("  deviceId:", err.deviceId)
    console.error("Inside the OpenClaw container, run:")
    console.error(`  openclaw devices approve ${err.requestId}`)
    console.error("Or use: openclaw devices list  # then approve the pending id")
    console.error("Re-run this probe after approval; a deviceToken will be saved under your OPENCLAW_DEVICE_TOKEN_PATH.")
    process.exit(2)
  }
  console.error(err)
  process.exit(1)
})
