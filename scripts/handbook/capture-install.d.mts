import type * as fs from 'node:fs'

type PreviousFile = { source: string; relativePath: string }
type StagedFile = { source: string; destination: string }

export function installCapture(options: {
  stageRoot: string
  previousFiles: PreviousFile[]
  stagedFiles: StagedFile[]
  metadataSource: string
  metadataDestination: string
  fileSystem?: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'renameSync' | 'rmSync'>
}): void
