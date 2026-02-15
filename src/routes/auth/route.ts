/**
 * Auth 路由
 */

import { Hono } from "hono"
import {
    isAuthenticated,
    getUserInfo,
    setAuth,
    clearAuth,
    startOAuthLogin,
    startAntigravityOAuthSession,
    pollAntigravityOAuthSession,
    cancelAntigravityOAuthSession,
} from "~/services/antigravity/login"
import { accountManager } from "~/services/antigravity/account-manager"
import { state } from "~/lib/state"
import { authStore } from "~/services/auth/store"
import {
    debugCodexOAuth,
    importCodexAuthSources,
    getCodexCliLoginStatus,
    startCodexOAuthSession,
    pollCodexOAuthSession,
    cancelCodexOAuthSession,
    cancelCodexCliLoginSession,
} from "~/services/codex/oauth"
import { startCopilotDeviceFlow, pollCopilotSession, importCopilotAuthFiles } from "~/services/copilot/oauth"

export const authRouter = new Hono()

function syncAntigravityAccountFromState(): void {
    accountManager.load()
    if (!state.accessToken) return
    accountManager.addAccount({
        id: state.userEmail || `account-${Date.now()}`,
        email: state.userEmail || "unknown",
        accessToken: state.accessToken,
        refreshToken: state.refreshToken || "",
        expiresAt: state.tokenExpiresAt || 0,
        projectId: state.cloudaicompanionProject,
    })
}

// 获取认证状态
authRouter.get("/status", (c) => {
    const userInfo = getUserInfo()
    return c.json({
        authenticated: isAuthenticated(),
        email: userInfo.email,
        name: userInfo.name,
    })
})

authRouter.get("/accounts", (c) => {
    accountManager.load()
    return c.json({
        accounts: {
            antigravity: authStore.listSummaries("antigravity"),
            codex: authStore.listSummaries("codex"),
            copilot: authStore.listSummaries("copilot"),
        },
    })
})

// Credential export/import has been removed.
authRouter.get("/export", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

// Credential export/import has been removed.
authRouter.post("/import", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

// 登录（触发 OAuth 或设置 token）
authRouter.post("/login", async (c) => {
    try {
        // 尝试解析 body，如果为空则触发 OAuth
        let body: { accessToken?: string; refreshToken?: string; email?: string; name?: string; provider?: string; force?: boolean } = {}
        try {
            const text = await c.req.text()
            if (text && text.trim()) {
                body = JSON.parse(text)
            }
        } catch {
            // body 为空或无效 JSON
        }

        const provider = (body.provider || "antigravity").toLowerCase()
        const forceInteractive = body.force === true

        if (provider === "copilot") {
            if (!forceInteractive) {
                const imported = importCopilotAuthFiles()
                if (imported.length > 0) {
                    return c.json({
                        success: true,
                        status: "success",
                        provider: "copilot",
                        source: "import",
                        login: imported[0].login,
                    })
                }
            }
            const session = await startCopilotDeviceFlow()
            return c.json({
                success: true,
                status: "pending",
                provider: "copilot",
                device_code: session.deviceCode,
                user_code: session.userCode,
                verification_uri: session.verificationUri,
                interval: session.interval,
            })
        }

        if (provider === "codex") {
            if (forceInteractive) {
                try {
                    const session = startCodexOAuthSession()
                    return c.json({
                        success: true,
                        provider: "codex",
                        status: "pending",
                        source: "browser-oauth",
                        oauth_state: session.state,
                        auth_url: session.authUrl,
                        fallback_url: session.fallbackUrl,
                        redirect_uri: session.redirectUri,
                        expires_at: session.expiresAt,
                    })
                } catch (error) {
                    return c.json({ success: false, error: (error as Error).message }, 400)
                }
            }

            const result = await importCodexAuthSources()
            if (result.accounts.length > 0) {
                return c.json({
                    success: true,
                    provider: "codex",
                    status: "success",
                    source: "import",
                    count: result.accounts.length,
                    sources: result.sources,
                    accounts: result.accounts.map(account => ({
                        id: account.id,
                        email: account.email,
                        source: account.authSource,
                    })),
                })
            }
            return c.json({
                success: false,
                error: "Codex auth files not found. Use force=true to login via browser.",
            }, 400)
        }

        // 默认 Antigravity
        if (forceInteractive) {
            try {
                const session = await startAntigravityOAuthSession()
                return c.json({
                    success: true,
                    provider: "antigravity",
                    status: "pending",
                    source: "browser-oauth",
                    oauth_state: session.state,
                    auth_url: session.authUrl,
                    redirect_uri: session.redirectUri,
                    expires_at: session.expiresAt,
                })
            } catch (error) {
                return c.json({ success: false, error: (error as Error).message }, 400)
            }
        }

        if (!body.accessToken) {
            const result = await startOAuthLogin()
            if (result.success) {
                syncAntigravityAccountFromState()
                return c.json({
                    success: true,
                    authenticated: true,
                    provider: "antigravity",
                    email: result.email,
                })
            } else {
                return c.json({ success: false, error: result.error }, 400)
            }
        }

        setAuth(body.accessToken, body.refreshToken, body.email, body.name)
        syncAntigravityAccountFromState()
        return c.json({
            success: true,
            authenticated: true,
            provider: "antigravity",
            email: body.email,
            name: body.name,
        })
    } catch (error) {
        return c.json({ error: (error as Error).message }, 500)
    }
})

authRouter.get("/copilot/status", async (c) => {
    const deviceCode = c.req.query("device_code")
    if (!deviceCode) {
        return c.json({ success: false, error: "device_code required" }, 400)
    }
    const session = await pollCopilotSession(deviceCode)
    return c.json({
        success: session.status !== "error",
        status: session.status,
        message: session.message,
        account: session.account ? {
            id: session.account.id,
            login: session.account.login,
            email: session.account.email,
        } : undefined,
    })
})

authRouter.get("/codex/status", async (c) => {
    const sessionId = c.req.query("session_id")
    if (!sessionId) {
        return c.json({ success: false, error: "session_id required" }, 400)
    }
    const result = await getCodexCliLoginStatus(sessionId)
    return c.json({
        success: result.status !== "error",
        status: result.status,
        message: result.message,
        verification_uri: result.verificationUri,
        user_code: result.userCode,
        accounts: result.accounts?.map(account => ({
            id: account.id,
            email: account.email,
            source: account.authSource,
        })),
    })
})

authRouter.get("/codex/oauth/status", async (c) => {
    const oauthState = c.req.query("state")
    if (!oauthState) {
        return c.json({ success: false, error: "state required" }, 400)
    }
    const result = await pollCodexOAuthSession(oauthState)
    return c.json({
        success: result.status !== "error",
        status: result.status,
        message: result.message,
        account: result.account ? {
            id: result.account.id,
            email: result.account.email,
            source: result.account.authSource,
        } : undefined,
    })
})

authRouter.post("/codex/oauth/cancel", (c) => {
    const oauthState = c.req.query("state")
    const cancelled = cancelCodexOAuthSession(oauthState)
    return c.json({ success: cancelled })
})

authRouter.post("/codex/cancel", (c) => {
    const sessionId = c.req.query("session_id")
    const cancelled = cancelCodexCliLoginSession(sessionId)
    return c.json({ success: cancelled })
})

authRouter.get("/antigravity/oauth/status", async (c) => {
    const oauthState = c.req.query("state")
    if (!oauthState) {
        return c.json({ success: false, error: "state required" }, 400)
    }
    const result = await pollAntigravityOAuthSession(oauthState)
    if (result.status === "success") {
        syncAntigravityAccountFromState()
    }
    return c.json({
        success: result.status !== "error",
        status: result.status,
        message: result.message,
        email: result.email,
    })
})

authRouter.post("/antigravity/oauth/cancel", (c) => {
    const oauthState = c.req.query("state")
    const cancelled = cancelAntigravityOAuthSession(oauthState)
    return c.json({ success: cancelled })
})

authRouter.get("/codex/debug", async (c) => {
    try {
        const result = await debugCodexOAuth()
        return c.json({ success: true, ...result })
    } catch (error) {
        return c.json({ success: false, error: (error as Error).message }, 500)
    }
})

// 登出
authRouter.post("/logout", (c) => {
    clearAuth()
    return c.json({ success: true, authenticated: false })
})
