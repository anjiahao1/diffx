export interface CommentReply {
  id: string
  body: string
  createdAt: number
  author?: 'user' | 'bot'
}

export interface ReviewComment {
  id: string
  filePath: string
  side: 'deletions' | 'additions'
  lineNumber: number
  lineContent: string
  body: string
  status: 'open' | 'resolved'
  createdAt: number
  replies: CommentReply[]
  // Set when the comment was made in the per-commit view: the commit it
  // anchors to and the file blob oid at comment time (enables the
  // "diff since comment" view via /api/patchset-diff).
  repo?: string
  commitSha?: string
  fileOid?: string
  // Character range within `lineContent` the comment targets, when the
  // reviewer selected a stretch of text in the line (0-based, exclusive end).
  columnStart?: number
  columnEnd?: number
}
