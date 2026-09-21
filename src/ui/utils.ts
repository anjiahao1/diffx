import { parsePatchFiles } from '@pierre/diffs'
import type { FileDiffMetadata } from '@pierre/diffs'

// Synthetic file path anchoring commit-message comments; rendered in the
// per-commit view as an added file so message lines are commentable like
// any other file's lines.
export const COMMIT_MESSAGE = 'COMMIT_MESSAGE'

// Model the commit message as a fake "added file" patch, so the standard
// diff pipeline (parse -> FileDiff card -> line/column comments) applies
// unchanged. Null when the message can't be parsed (shouldn't happen).
export function buildCommitMessageFile(message: string): FileDiffMetadata | null {
  const lines = message.split('\n')
  const patch = [
    `diff --git a/${COMMIT_MESSAGE} b/${COMMIT_MESSAGE}`,
    'new file mode 100644',
    `--- a/${COMMIT_MESSAGE}`,
    `+++ b/${COMMIT_MESSAGE}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n')
  try {
    const parsed = parsePatchFiles(patch)
    return parsed.flatMap((p) => p.files)[0] ?? null
  } catch {
    return null
  }
}

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function truncate(text: string, maxLen: number): string {
  const firstLine = text.split('\n')[0]
  if (firstLine.length <= maxLen) return firstLine
  return firstLine.slice(0, maxLen) + '…'
}

export function fileName(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1]
}
