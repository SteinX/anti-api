/**
 * Server-side Settings Service
 * Stores user preferences in a JSON file
 */

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "fs"
import { join } from "path"
import { ensureDataDir, getDataDir } from "~/lib/data-dir"

function getSettingsFile(): string {
    const settingsDir = getDataDir()
    return join(settingsDir, "settings.json")
}

export type ReasoningEffort = "none" | "low" | "medium" | "high"
export interface AppSettings {
    preloadRouting: boolean
    autoNgrok: boolean
    autoOpenDashboard: boolean
    autoRefresh: boolean
    autoRestart: boolean
    privacyMode: boolean
    compactLayout: boolean
    trackUsage: boolean
    optimizeQuotaSort: boolean
    captureLogs: boolean
    reasoningEffort: ReasoningEffort
}

const DEFAULT_SETTINGS: AppSettings = {
    preloadRouting: true,
    autoNgrok: false,
    autoOpenDashboard: true,
    autoRefresh: true,
    autoRestart: false,
    privacyMode: false,
    compactLayout: false,
    trackUsage: true,
    optimizeQuotaSort: false,
    captureLogs: false,
    reasoningEffort: "medium",
}

function ensureSettingsDir(): void {
    ensureDataDir()
}

export function loadSettings(): AppSettings {
    try {
        ensureSettingsDir()
        const settingsFile = getSettingsFile()
        if (existsSync(settingsFile)) {
            const data = readFileSync(settingsFile, "utf-8")
            return { ...DEFAULT_SETTINGS, ...JSON.parse(data) }
        }
    } catch (error) {
        // Ignore errors, return defaults
    }
    return { ...DEFAULT_SETTINGS }
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
    ensureSettingsDir()
    const settingsFile = getSettingsFile()
    const current = loadSettings()
    const updated = { ...current, ...settings }
    const payload = JSON.stringify(updated, null, 2)
    const tmpFile = `${settingsFile}.tmp`
    writeFileSync(tmpFile, payload, "utf-8")
    try {
        renameSync(tmpFile, settingsFile)
    } catch {
        try {
            rmSync(settingsFile, { force: true })
        } catch {
            // Ignore cleanup failures, rename will throw if it still can't proceed.
        }
        renameSync(tmpFile, settingsFile)
    }
    return updated
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return loadSettings()[key]
}
