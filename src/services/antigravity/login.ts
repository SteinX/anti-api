/**
 * Antigravity OAuth 登录服务
 * 完整的 OAuth 登录流程实现
 */

import { state } from "~/lib/state"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import consola from "consola"
import {
    startOAuthCallbackServer,
    generateState,
    generateAuthURL,
    exchangeCode,
    fetchUserInfo,
    getProjectID,
    refreshAccessToken,
} from "./oauth"
import { generateMockProjectId } from "./project-id"
import { ensureDataDir, getDataDir, getLegacyProjectDataDir } from "~/lib/data-dir"

const AUTH_FILE = join(getDataDir(), "auth.json")
const LEGACY_AUTH_FILE = join(getLegacyProjectDataDir(), "auth.json")

interface AuthData {
    accessToken: string
    refreshToken: string
    userEmail?: string
    userName?: string
    expiresAt?: number
    projectId?: string
}

type OAuthCallbackResult = {
    code?: string
    state?: string
    error?: string
}

type AntigravityOAuthSession = {
    state: string
    authUrl: string
    redirectUri: string
    expiresAt: number
    server: { stop: () => void }
    callback?: OAuthCallbackResult
}

let activeAntigravityOAuthSession: AntigravityOAuthSession | null = null

function printManualAuthUrl(url: string): void {
    const line = `[anti-api] Antigravity login URL: ${url}`
    try {
        process.stdout.write(`${line}\n`)
    } catch {
        console.log(line)
    }
}

function openBrowser(url: string): boolean {
    const platform = process.platform
    let cmd = "xdg-open"
    let args = [url]
    if (platform === "darwin") {
        cmd = "open"
    } else if (platform === "win32") {
        cmd = "cmd"
        args = ["/c", "start", url]
    }
    try {
        Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" })
        return true
    } catch {
        return false
    }
}

function stopAntigravityOAuthSession(): void {
    if (!activeAntigravityOAuthSession) return
    try {
        activeAntigravityOAuthSession.server.stop()
    } catch {}
    activeAntigravityOAuthSession = null
}

async function completeOAuthCallbackLogin(
    callbackResult: OAuthCallbackResult,
    oauthState: string,
    redirectUri: string
): Promise<{ success: boolean; error?: string; email?: string }> {
    if (callbackResult.error) {
        return { success: false, error: callbackResult.error }
    }

    if (!callbackResult.code || !callbackResult.state) {
        return { success: false, error: "Missing code or state in callback" }
    }

    if (callbackResult.state !== oauthState) {
        return { success: false, error: "State mismatch - possible CSRF attack" }
    }

    const tokens = await exchangeCode(callbackResult.code, redirectUri)
    const userInfo = await fetchUserInfo(tokens.accessToken)
    const projectId = await getProjectID(tokens.accessToken)
    const resolvedProjectId = projectId || generateMockProjectId()
    if (!projectId) {
        consola.warn(`No project ID returned, using fallback: ${resolvedProjectId}`)
    }

    state.accessToken = tokens.accessToken
    state.antigravityToken = tokens.accessToken
    state.refreshToken = tokens.refreshToken
    state.tokenExpiresAt = Date.now() + tokens.expiresIn * 1000
    state.userEmail = userInfo.email
    state.userName = userInfo.email.split("@")[0]
    state.cloudaicompanionProject = resolvedProjectId

    saveAuth()

    consola.success(`✓ Login successful: ${userInfo.email}`)
    consola.success(`✓ Project ID: ${resolvedProjectId}`)
    return { success: true, email: userInfo.email }
}

export async function startAntigravityOAuthSession(): Promise<{
    state: string
    authUrl: string
    redirectUri: string
    expiresAt: number
}> {
    if (activeAntigravityOAuthSession && Date.now() < activeAntigravityOAuthSession.expiresAt) {
        return {
            state: activeAntigravityOAuthSession.state,
            authUrl: activeAntigravityOAuthSession.authUrl,
            redirectUri: activeAntigravityOAuthSession.redirectUri,
            expiresAt: activeAntigravityOAuthSession.expiresAt,
        }
    }

    stopAntigravityOAuthSession()

    const { server, port, waitForCallback } = await startOAuthCallbackServer()
    const oauthState = generateState()
    const redirectUri = process.env.ANTI_API_OAUTH_REDIRECT_URL || `http://localhost:${port}/oauth-callback`
    const authUrl = generateAuthURL(redirectUri, oauthState)

    activeAntigravityOAuthSession = {
        state: oauthState,
        authUrl,
        redirectUri,
        expiresAt: Date.now() + 5 * 60 * 1000,
        server,
    }

    void waitForCallback()
        .then((result) => {
            if (!activeAntigravityOAuthSession || activeAntigravityOAuthSession.state !== oauthState) return
            activeAntigravityOAuthSession.callback = result
        })
        .catch((error) => {
            if (!activeAntigravityOAuthSession || activeAntigravityOAuthSession.state !== oauthState) return
            activeAntigravityOAuthSession.callback = { error: (error as Error).message }
        })

    return {
        state: oauthState,
        authUrl,
        redirectUri,
        expiresAt: activeAntigravityOAuthSession.expiresAt,
    }
}

export async function pollAntigravityOAuthSession(oauthState: string): Promise<{
    status: "pending" | "success" | "error"
    message?: string
    email?: string
}> {
    const session = activeAntigravityOAuthSession
    if (!session || session.state !== oauthState) {
        return { status: "error", message: "No active Antigravity OAuth session" }
    }

    if (Date.now() > session.expiresAt) {
        stopAntigravityOAuthSession()
        return { status: "error", message: "Authentication timeout (5 minutes)" }
    }

    if (!session.callback) {
        return { status: "pending" }
    }

    try {
        const loginResult = await completeOAuthCallbackLogin(session.callback, session.state, session.redirectUri)
        stopAntigravityOAuthSession()
        if (!loginResult.success) {
            return { status: "error", message: loginResult.error || "Antigravity authentication failed" }
        }
        return { status: "success", email: loginResult.email }
    } catch (error) {
        stopAntigravityOAuthSession()
        return { status: "error", message: (error as Error).message }
    }
}

export function cancelAntigravityOAuthSession(oauthState?: string): boolean {
    if (!activeAntigravityOAuthSession) return false
    if (oauthState && activeAntigravityOAuthSession.state !== oauthState) return false
    stopAntigravityOAuthSession()
    return true
}

/**
 * 初始化认证 - 从文件加载已保存的认证
 */
export function initAuth(): void {
    try {
        const source = existsSync(AUTH_FILE) ? AUTH_FILE : (existsSync(LEGACY_AUTH_FILE) ? LEGACY_AUTH_FILE : null)
        if (source) {
            const data = JSON.parse(readFileSync(source, "utf-8")) as AuthData
            if (data.accessToken) {
                state.accessToken = data.accessToken
                state.antigravityToken = data.accessToken
                state.refreshToken = data.refreshToken || null
                state.tokenExpiresAt = data.expiresAt || null
                state.userEmail = data.userEmail || null
                state.userName = data.userName || null
                state.cloudaicompanionProject = data.projectId || null
                if (source === LEGACY_AUTH_FILE && !existsSync(AUTH_FILE)) {
                    saveAuth()
                }
                consola.success("Loaded saved authentication")
            }
        }
    } catch (error) {
        consola.warn("Failed to load saved auth:", error)
    }
}

/**
 * 保存认证到文件
 */
export function saveAuth(): void {
    try {
        ensureDataDir()

        const data: AuthData = {
            accessToken: state.accessToken!,
            refreshToken: state.refreshToken || "",
            expiresAt: state.tokenExpiresAt || undefined,
            userEmail: state.userEmail || undefined,
            userName: state.userName || undefined,
            projectId: state.cloudaicompanionProject || undefined,
        }

        writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2))
        consola.success("Authentication saved")
    } catch (error) {
        consola.error("Failed to save auth:", error)
    }
}

/**
 * 清除认证
 */
export function clearAuth(): void {
    state.accessToken = null
    state.antigravityToken = null
    state.refreshToken = null
    state.userEmail = null
    state.userName = null
    state.cloudaicompanionProject = null

    try {
        if (existsSync(AUTH_FILE)) {
            writeFileSync(AUTH_FILE, "{}")
        }
        if (existsSync(LEGACY_AUTH_FILE)) {
            writeFileSync(LEGACY_AUTH_FILE, "{}")
        }
    } catch (error) {
        consola.warn("Failed to clear auth file:", error)
    }
}

/**
 * 检查是否已认证
 */
export function isAuthenticated(): boolean {
    return !!state.accessToken
}

/**
 * 获取用户信息
 */
export function getUserInfo(): { email: string | null; name: string | null } {
    return {
        email: state.userEmail,
        name: state.userName,
    }
}

/**
 * 设置认证信息
 */
export function setAuth(accessToken: string, refreshToken?: string, email?: string, name?: string): void {
    state.accessToken = accessToken
    state.antigravityToken = accessToken
    state.refreshToken = refreshToken || null
    state.userEmail = email || null
    state.userName = name || null
    saveAuth()
}

/**
 * 启动 OAuth 登录流程
 */
export async function startOAuthLogin(): Promise<{ success: boolean; error?: string; email?: string }> {
    let oauthServer: { stop: () => void } | null = null
    try {

        // 1. 启动回调服务器
        const { server, port, waitForCallback } = await startOAuthCallbackServer()
        oauthServer = server

        // 2. 生成授权 URL
        const oauthState = generateState()
        const redirectUri = process.env.ANTI_API_OAUTH_REDIRECT_URL || `http://localhost:${port}/oauth-callback`
        const authUrl = generateAuthURL(redirectUri, oauthState)
        printManualAuthUrl(authUrl)

        // 3. 打开浏览器
        consola.info(`Open this URL to login: ${authUrl}`)
        if (process.env.ANTI_API_OAUTH_NO_OPEN !== "1") {
            if (!openBrowser(authUrl)) {
                consola.warn("Failed to open browser automatically")
            }
        }

        // 4. 等待回调（5分钟超时）
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Authentication timeout (5 minutes)")), 5 * 60 * 1000)
        })

        const callbackResult = await Promise.race([
            waitForCallback(),
            timeoutPromise,
        ])

        // 5. 关闭服务器
        server.stop()
        oauthServer = null

        return await completeOAuthCallbackLogin(callbackResult, oauthState, redirectUri)
    } catch (error) {
        consola.error("OAuth login failed:", error)
        return { success: false, error: (error as Error).message }
    } finally {
        if (oauthServer) {
            try {
                oauthServer.stop()
            } catch {}
        }
    }
}

/**
 * 刷新 access token
 */
export async function refreshToken(): Promise<boolean> {
    if (!state.refreshToken) {
        return false
    }

    try {
        const tokens = await refreshAccessToken(state.refreshToken)
        state.accessToken = tokens.accessToken
        state.antigravityToken = tokens.accessToken
        saveAuth()
        consola.success("Token refreshed successfully")
        return true
    } catch (error) {
        consola.error("Token refresh failed:", error)
        return false
    }
}
