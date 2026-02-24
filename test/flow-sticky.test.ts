import { test, expect, mock, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { UpstreamError } from "../src/lib/error"

const quotaErrorBody = JSON.stringify({
    error: {
        code: 429,
        message: "Quota exhausted",
        status: "RESOURCE_EXHAUSTED",
        details: [
            {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "QUOTA_EXHAUSTED",
                domain: "cloudcode-pa.googleapis.com",
                metadata: { model: "claude-opus-4-5-thinking" },
            },
        ],
    },
})

function makeQuotaError(): UpstreamError {
    return new UpstreamError("antigravity", 429, quotaErrorBody)
}

let scenario: "none" | "head-exhausted" | "probe-head" = "head-exhausted"
const callOrder: string[] = []
const callCounts = new Map<string, number>()
let rateLimitAll = false

function resetTracking(resetCounts: boolean) {
    callOrder.length = 0
    if (resetCounts) {
        callCounts.clear()
    }
}

mock.module("~/services/antigravity/chat", () => ({
    createChatCompletionWithOptions: async (_request: any, options: { accountId?: string }) => {
        const accountId = options?.accountId || "auto"
        callOrder.push(accountId)
        callCounts.set(accountId, (callCounts.get(accountId) ?? 0) + 1)

        if (scenario === "head-exhausted") {
            if (accountId === "acc1") throw makeQuotaError()
        }

        if (scenario === "probe-head") {
            if (accountId === "b1") throw makeQuotaError()
            if (accountId === "b2") {
                const count = callCounts.get(accountId) ?? 0
                if (count >= 2) throw makeQuotaError()
            }
        }

        return {
            contentBlocks: [{ type: "text", text: "ok" }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
        }
    },
    createChatCompletionStreamWithOptions: async function* () {
        yield ""
    },
}))

mock.module("~/services/antigravity/account-manager", () => ({
    accountManager: {
        hasAccount: () => true,
        isAccountRateLimited: () => rateLimitAll,
        isAccountInFlight: () => false,
        markRateLimitedFromError: async () => ({ reason: "quota_exhausted", durationMs: 60_000 }),
        clearAllRateLimits: () => { },
    },
}))

let createRoutedCompletion: (request: any) => Promise<any>
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeAll(async () => {
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE

    const tempHome = mkdtempSync(join(tmpdir(), "anti-api-test-"))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome

    const configDir = join(tempHome, ".anti-api")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "routing.json"), JSON.stringify({
        version: 2,
        updatedAt: new Date().toISOString(),
        flows: [
            {
                id: "flow-head",
                name: "flow-head",
                entries: [
                    { id: "e1", provider: "antigravity", accountId: "acc1", modelId: "claude-opus-4-5-thinking", label: "Opus 1" },
                    { id: "e2", provider: "antigravity", accountId: "acc2", modelId: "claude-opus-4-5-thinking", label: "Opus 2" },
                    { id: "e3", provider: "antigravity", accountId: "acc3", modelId: "claude-opus-4-5-thinking", label: "Opus 3" },
                ],
            },
            {
                id: "flow-probe",
                name: "flow-probe",
                entries: [
                    { id: "p1", provider: "antigravity", accountId: "b1", modelId: "claude-opus-4-5-thinking", label: "Opus 1" },
                    { id: "p2", provider: "antigravity", accountId: "b2", modelId: "claude-opus-4-5-thinking", label: "Opus 2" },
                    { id: "p3", provider: "antigravity", accountId: "b3", modelId: "claude-opus-4-5-thinking", label: "Opus 3" },
                ],
            },
            {
                id: "flow-rate-limit",
                name: "flow-rate-limit",
                entries: [
                    { id: "r1", provider: "antigravity", accountId: "r1", modelId: "claude-opus-4-5-thinking", label: "Opus 1" },
                    { id: "r2", provider: "antigravity", accountId: "r2", modelId: "claude-opus-4-5-thinking", label: "Opus 2" },
                ],
            },
        ],
        accountRouting: { smartSwitch: false, routes: [] },
    }, null, 2))

    const router = await import("../src/services/routing/router")
    createRoutedCompletion = router.createRoutedCompletion
})

afterAll(() => {
    process.env.HOME = originalHome
    process.env.USERPROFILE = originalUserProfile
})

test("flow sticky skips exhausted head on subsequent requests", async () => {
    scenario = "head-exhausted"
    rateLimitAll = false
    resetTracking(true)

    await createRoutedCompletion({
        model: "flow-head",
        messages: [{ role: "user", content: "hi" }],
    })
    expect(callOrder).toEqual(["acc1", "acc2"])

    resetTracking(false)
    await createRoutedCompletion({
        model: "flow-head",
        messages: [{ role: "user", content: "hi again" }],
    })
    expect(callOrder).toEqual(["acc2"])
})

test("flow sticky probes head only when current account is exhausted", async () => {
    scenario = "probe-head"
    rateLimitAll = false
    resetTracking(true)

    await createRoutedCompletion({
        model: "flow-probe",
        messages: [{ role: "user", content: "start" }],
    })
    expect(callOrder).toEqual(["b1", "b2"])

    resetTracking(false)
    await createRoutedCompletion({
        model: "flow-probe",
        messages: [{ role: "user", content: "next" }],
    })
    expect(callOrder).toEqual(["b2", "b1", "b3"])

    resetTracking(false)
    await createRoutedCompletion({
        model: "flow-probe",
        messages: [{ role: "user", content: "again" }],
    })
    expect(callOrder).toEqual(["b3"])
})

test("flow sticky falls back to cursor when all entries are rate limited", async () => {
    scenario = "none"
    rateLimitAll = true
    resetTracking(true)

    await createRoutedCompletion({
        model: "flow-rate-limit",
        messages: [{ role: "user", content: "rate limit" }],
    })
    expect(callOrder).toEqual(["r1"])
})
