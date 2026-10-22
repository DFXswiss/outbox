// JavaScript keeps this filesystem-only installer importable from capture.mjs, which loads Playwright outside the project package context.
import * as fs from 'node:fs'
import { dirname, join } from 'node:path'

export function installCapture({ stageRoot, previousFiles, stagedFiles, metadataSource, metadataDestination, fileSystem = fs }) {
  const backupRoot = join(stageRoot, 'backup')
  fileSystem.mkdirSync(backupRoot, { recursive: true })
  const backedUp = []
  const installed = []
  try {
    for (const { source, relativePath } of previousFiles) {
      if (!fileSystem.existsSync(source)) continue
      const backup = join(backupRoot, relativePath)
      fileSystem.mkdirSync(dirname(backup), { recursive: true })
      fileSystem.renameSync(source, backup)
      backedUp.push({ source, backup })
    }
    for (const { source, destination } of stagedFiles) {
      fileSystem.mkdirSync(dirname(destination), { recursive: true })
      fileSystem.renameSync(source, destination)
      installed.push(destination)
    }
    fileSystem.renameSync(metadataSource, metadataDestination)
    installed.push(metadataDestination)
  } catch (installError) {
    for (const path of installed) {
      try { fileSystem.rmSync(path, { force: true }) } catch {}
    }
    const restoreErrors = []
    for (const { source, backup } of backedUp.reverse()) {
      try {
        fileSystem.mkdirSync(dirname(source), { recursive: true })
        if (fileSystem.existsSync(backup)) fileSystem.renameSync(backup, source)
      } catch (error) {
        restoreErrors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (restoreErrors.length) {
      const error = new Error(`Capture install failed; restore errors: ${restoreErrors.join('; ')}; backup path: ${backupRoot}; install error: ${installError instanceof Error ? installError.message : String(installError)}`)
      error.preserveStageRoot = stageRoot
      error.backupPath = backupRoot
      throw error
    }
    throw installError
  }
}
