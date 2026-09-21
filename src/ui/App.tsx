import { useState, useMemo, useCallback, useEffect } from 'react'
import { Resizable } from 'react-resizable'
import { parsePatchFiles } from '@pierre/diffs'
import { Virtualizer } from '@pierre/diffs/react'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { ReviewComment } from '../types'
import { useDiff } from './hooks/useDiff'
import type { DiffView } from './hooks/useDiff'
import { useComments } from './hooks/useComments'
import { useSettings } from './hooks/useSettings'
import { useViewed } from './hooks/useViewed'
import { useCommits } from './hooks/useCommits'
import { useFullDiffs, fileKey } from './hooks/useFullDiffs'
import { Toolbar } from './components/Toolbar'
import { DiffViewer } from './components/DiffViewer'
import { FileTree } from './components/FileTree'
import { CommitList } from './components/CommitList'
import type { SelectedCommit } from './components/CommitList'
import { COMMIT_MESSAGE, buildCommitMessageFile } from './utils'
import { CommentTracker } from './components/CommentTracker'
import { AiNote } from './components/AiNote'
import { ReviewDoneButton } from './components/ReviewDoneButton'
import { SidebarStorage } from './sidebarStorage'

function useWindowSize({ factor }: { factor: number }) {
  const compute = () => Math.round(window.innerWidth * factor)

  const [size, setSize] = useState(compute)

  useEffect(() => {
    const handleResize = () => setSize(compute())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [factor])

  return size
}

export function App() {
  const { settings, loaded, updateSettings } = useSettings()
  const [selectedCommit, setSelectedCommit] = useState<SelectedCommit | null>(null)
  // Per-commit view (Gerrit-style): the diff switches to that commit's patch.
  const view: DiffView | undefined = selectedCommit
    ? { commit: selectedCommit.sha, repo: selectedCommit.repo }
    : undefined
  const { patch, repoName, branch, customMode, binaryFiles, tabSizeMap, untrackedFiles, repos, commitMessage, loading, error } = useDiff(
    {
      staged: settings.staged,
      untracked: settings.untracked,
    },
    view,
  )
  const { comments, addComment, removeComment, addReply, resolveComment, copyAllComments } =
    useComments()
  const repoCommits = useCommits()
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [sidebar, setSidebar] = useState(() => SidebarStorage.load())
  const maxSidebarWidth = Math.max(SidebarStorage.minSize, useWindowSize({ factor: 0.5 }))

  // Note to the reviewing agent: loaded once, saved on demand.
  const [aiNote, setAiNote] = useState('')
  const [aiNoteSaved, setAiNoteSaved] = useState(false)
  useEffect(() => {
    fetch('/api/ai-note')
      .then((res) => res.json())
      .then((d) => setAiNote(d.note ?? ''))
      .catch(() => {})
  }, [])
  const saveAiNote = useCallback(async () => {
    await fetch('/api/ai-note', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: aiNote }),
    })
    setAiNoteSaved(true)
  }, [aiNote])

  const handleResize = useCallback((_e: React.SyntheticEvent, data: { size: { width: number } }) => {
    setSidebar((prev) => prev.withSize(data.size.width))
  }, [])

  const handleResizeStop = useCallback((_e: React.SyntheticEvent, data: { size: { width: number } }) => {
    setSidebar((prev) => prev.withSize(data.size.width).save())
  }, [])

  const handleToggleCollapse = useCallback(() => {
    setSidebar((prev) => prev.withCollapsed(!prev.collapsed).save())
  }, [])

  const untrackedSet = useMemo(() => new Set(untrackedFiles), [untrackedFiles])

  const files = useMemo(() => {
    if (!patch) return []
    try {
      const parsed = parsePatchFiles(patch)
      const parsedFiles = parsed.flatMap((p) => p.files)

      // Per-commit view: the commit message leads the diff as an added
      // "file" (COMMIT_MESSAGE), so its lines are commentable like any file.
      if (selectedCommit && commitMessage) {
        const msgFile = buildCommitMessageFile(commitMessage)
        if (msgFile) parsedFiles.unshift(msgFile)
      }

      const existingNames = new Set(parsedFiles.map((f) => f.name))
      for (const bf of binaryFiles) {
        if (!existingNames.has(bf.path)) {
          const syntheticFile: FileDiffMetadata = {
            name: bf.path,
            type: bf.type === 'added' || bf.type === 'untracked' ? 'new' : bf.type === 'deleted' ? 'deleted' : 'change',
            hunks: [],
            splitLineCount: 0,
            unifiedLineCount: 0,
            isPartial: true,
            deletionLines: [],
            additionLines: [],
          }
          parsedFiles.push(syntheticFile)
        }
      }

      return parsedFiles
    } catch {
      return []
    }
  }, [patch, binaryFiles, selectedCommit, commitMessage])

  const fullFiles = useFullDiffs(patch, files, { staged: settings.staged, untracked: settings.untracked, view })
  const displayFiles = useMemo(() => {
    if (fullFiles.size === 0) return files
    return files.map((f) => fullFiles.get(fileKey(f)) ?? f)
  }, [files, fullFiles])

  const { viewedFiles, setViewed } = useViewed(files)

  const diffStats = useMemo(() => {
    if (!patch) return { additions: 0, deletions: 0 }
    let additions = 0
    let deletions = 0
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++
    }
    return { additions, deletions }
  }, [patch])

  const binaryFileMap = useMemo(() => {
    const map = new Map<string, (typeof binaryFiles)[number]>()
    for (const bf of binaryFiles) {
      map.set(bf.path, bf)
    }
    return map
  }, [binaryFiles])

  const commentCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const c of comments) {
      counts[c.filePath] = (counts[c.filePath] ?? 0) + 1
    }
    return counts
  }, [comments])

  const fileAnnotationsMap = useMemo(() => {
    const map = new Map<string, { side: ReviewComment['side']; lineNumber: number; metadata: ReviewComment }[]>()
    for (const c of comments) {
      let list = map.get(c.filePath)
      if (!list) {
        list = []
        map.set(c.filePath, list)
      }
      list.push({
        side: c.side,
        lineNumber: c.lineNumber,
        metadata: c,
      })
    }
    return map
  }, [comments])

  const handleFileClick = useCallback((filePath: string) => {
    setActiveFile(filePath)
    const el = document.getElementById(`file-${filePath}`)
    if (el) {
      el.scrollIntoView({ block: 'start' })
    }
  }, [])

  const handleViewedChange = useCallback((filePath: string, viewed: boolean) => {
    setViewed(filePath, viewed)
  }, [setViewed])

  // Scroll to a comment's position in the main view. The comment bubble only
  // exists once its file's diff is rendered (virtualized — it may not be
  // mounted at all), so retry for a few seconds and fall back to the file
  // card anchor, which is present whenever the file is in the current patch.
  const scrollToComment = useCallback((commentId: string, fallbackFile: string) => {
    let tries = 0
    const tick = () => {
      const el =
        document.getElementById(`comment-${commentId}`) ??
        document.getElementById(`file-${fallbackFile}`)
      if (el) {
        el.scrollIntoView({ block: 'center' })
        return
      }
      if (++tries < 300) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [])

  // Comment list click: when the comment is anchored to a commit we're not
  // viewing, switch the main view to that commit first; scrolling then picks
  // the bubble up once its file renders.
  const jumpToComment = useCallback(
    (comment: ReviewComment) => {
      const target: SelectedCommit | null = comment.commitSha
        ? { repo: comment.repo, sha: comment.commitSha }
        : null
      const sameView =
        !!target === !!selectedCommit &&
        (!target || (target.repo === selectedCommit!.repo && target.sha === selectedCommit!.sha))
      if (!sameView) setSelectedCommit(target)
      scrollToComment(comment.id, comment.filePath)
    },
    [selectedCommit, scrollToComment],
  )

  // Comments made in the per-commit view anchor to that commit and record the
  // file blob oid at comment time (enables "diff since comment").
  const handleAddComment = useCallback(
    (filePath: string, side: 'deletions' | 'additions', lineNumber: number, lineContent: string, body: string, column?: { columnStart: number; columnEnd: number }) => {
      const file = displayFiles.find((f) => f.name === filePath)
      addComment(filePath, side, lineNumber, lineContent, body, {
        repo: selectedCommit?.repo,
        commitSha: selectedCommit?.sha,
        fileOid: file?.newObjectId,
        ...column,
      })
    },
    [addComment, selectedCommit, displayFiles],
  )

  const sidebarContent = (
    <div className="sidebar-content">
      {!sidebar.collapsed && (
        <CommitList
          repoCommits={repoCommits}
          selected={selectedCommit}
          onSelect={setSelectedCommit}
        />
      )}
      <FileTree
        files={files}
        activeFile={activeFile}
        commentCounts={commentCounts}
        viewedFiles={viewedFiles}
        untrackedFiles={untrackedSet}
        onFileClick={handleFileClick}
        collapsed={sidebar.collapsed}
        onToggleCollapse={handleToggleCollapse}
      />
      {!sidebar.collapsed && <CommentTracker comments={comments} onJumpToComment={jumpToComment} />}
      {!sidebar.collapsed && (
        <AiNote note={aiNote} onChange={(n) => { setAiNote(n); setAiNoteSaved(false) }} onSave={saveAiNote} saved={aiNoteSaved} />
      )}
      {!sidebar.collapsed && <ReviewDoneButton />}
    </div>
  )

  // First paint only: during view switches keep the previous diff rendered
  // (useDiff retains the old patch while loading the new one) instead of
  // unmounting everything into a white "Loading..." screen.
  if (!loaded || (loading && !patch)) {
    return (
      <div className="loading">
        <p>Loading diff...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="error">
        <p>Error: {error}</p>
      </div>
    )
  }

  return (
    <div className="app">
      <Toolbar
        repoName={repoName}
        branch={branch}
        repos={repos}
        viewing={selectedCommit}
        onExitCommitView={() => setSelectedCommit(null)}
        fileCount={files.length}
        additions={diffStats.additions}
        deletions={diffStats.deletions}
        commentCount={comments.length}
        diffStyle={settings.diffStyle}
        diffOptions={{ staged: settings.staged, untracked: settings.untracked }}
        defaultTabSize={settings.defaultTabSize}
        softWrap={settings.softWrap}
        browser={settings.browser}
        customMode={customMode}
        onDiffStyleChange={(style) => updateSettings({ diffStyle: style })}
        onDiffOptionsChange={(options) => updateSettings(options)}
        onDefaultTabSizeChange={(size) => updateSettings({ defaultTabSize: size })}
        onSoftWrapChange={(softWrap) => updateSettings({ softWrap })}
        onBrowserChange={(browser) => updateSettings({ browser })}
        onCopyComments={() => copyAllComments(aiNote)}
      />
      <div className="app-body">
        {sidebar.collapsed ? (
          <aside className="sidebar sidebar-collapsed" style={{ width: sidebar.visibleSize() }}>
            {sidebarContent}
          </aside>
        ) : (
          <Resizable
            width={sidebar.visibleSize(maxSidebarWidth)}
            height={0}
            axis="x"
            resizeHandles={['e']}
            minConstraints={[SidebarStorage.minSize, 0]}
            maxConstraints={[maxSidebarWidth, 0]}
            onResize={handleResize}
            onResizeStop={handleResizeStop}
            handle={<div className="sidebar-resize-handle" />}
          >
            <aside className="sidebar" style={{ width: sidebar.visibleSize(maxSidebarWidth) }}>
              {sidebarContent}
            </aside>
          </Resizable>
        )}
        <main className="main">
          <Virtualizer className="main-scroll" contentClassName="main-content">
            <DiffViewer
              files={displayFiles}
              diffStyle={settings.diffStyle}
              tabSizeMap={tabSizeMap}
              defaultTabSize={settings.defaultTabSize}
              softWrap={settings.softWrap}
              viewedFiles={viewedFiles}
              binaryFiles={binaryFileMap}
              onViewedChange={handleViewedChange}
              fileAnnotationsMap={fileAnnotationsMap}
              onAddComment={handleAddComment}
              onDeleteComment={removeComment}
              onResolveComment={resolveComment}
              onReply={addReply}
            />
          </Virtualizer>
        </main>
      </div>
    </div>
  )
}
