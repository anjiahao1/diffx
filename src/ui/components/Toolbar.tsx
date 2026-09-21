import { useState, useRef, useEffect } from 'react'
import { GitBranch, Layers, Settings, Undo2 } from 'lucide-react'
import type { DiffOptions, RepoMeta } from '../hooks/useDiff'
import type { SelectedCommit } from './CommitList'

interface ToolbarProps {
  repoName: string
  branch: string
  repos?: RepoMeta[]
  viewing?: SelectedCommit | null
  onExitCommitView: () => void
  fileCount: number
  additions: number
  deletions: number
  commentCount: number
  diffStyle: 'split' | 'unified'
  diffOptions: DiffOptions
  defaultTabSize: number
  softWrap: boolean
  browser?: string
  customMode: boolean
  onDiffStyleChange: (style: 'split' | 'unified') => void
  onDiffOptionsChange: (options: DiffOptions) => void
  onDefaultTabSizeChange: (size: number) => void
  onSoftWrapChange: (softWrap: boolean) => void
  onBrowserChange: (browser: string) => void
  onCopyComments: () => Promise<void>
}

export function Toolbar({
  repoName,
  branch,
  repos,
  viewing,
  onExitCommitView,
  fileCount,
  additions,
  deletions,
  commentCount,
  diffStyle,
  diffOptions,
  defaultTabSize,
  softWrap,
  browser,
  customMode,
  onDiffStyleChange,
  onDiffOptionsChange,
  onDefaultTabSizeChange,
  onSoftWrapChange,
  onBrowserChange,
  onCopyComments,
}: ToolbarProps) {
  const [copied, setCopied] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)

  const handleCopy = async () => {
    await onCopyComments()
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
    }
    if (settingsOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [settingsOpen])

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <h1 className="toolbar-title">{repoName}</h1>
        {repos ? (
          <span className="toolbar-branch" title={repos.map((r) => `${r.relPath} (${r.branch})`).join('\n')}>
            <Layers size={12} />
            {repos.length} repo{repos.length !== 1 ? 's' : ''} changed
          </span>
        ) : (
          branch && (
            <span className="toolbar-branch">
              <GitBranch size={12} />
              {branch}
            </span>
          )
        )}
        {viewing && (
          <span className="toolbar-viewing">
            viewing {viewing.repo ? `${viewing.repo}@` : ''}
            {viewing.sha.slice(0, 7)}
            <button className="btn btn-sm toolbar-back" onClick={onExitCommitView} title="Back to all changes">
              <Undo2 size={12} />
              All changes
            </button>
          </span>
        )}
        <span className="toolbar-stat">
          {fileCount} file{fileCount !== 1 ? 's' : ''} changed
          {additions > 0 && <span className="stat-additions"> +{additions}</span>}
          {deletions > 0 && <span className="stat-deletions"> -{deletions}</span>}
        </span>
      </div>
      <div className="toolbar-right">
        <div className="toolbar-toggle">
          <button
            className={`btn btn-sm ${diffStyle === 'split' ? 'btn-active' : ''}`}
            onClick={() => onDiffStyleChange('split')}
          >
            Split
          </button>
          <button
            className={`btn btn-sm ${diffStyle === 'unified' ? 'btn-active' : ''}`}
            onClick={() => onDiffStyleChange('unified')}
          >
            Unified
          </button>
        </div>
        <div className="settings-wrapper" ref={settingsRef}>
          <button
            className={`btn btn-sm settings-btn ${settingsOpen ? 'btn-active' : ''}`}
            onClick={() => setSettingsOpen(!settingsOpen)}
            title="Settings"
          >
            <Settings size={14} />
          </button>
          {settingsOpen && (
            <div className="settings-menu">
              {!customMode && !repos && (
                <label className="settings-item">
                  <input
                    type="checkbox"
                    checked={diffOptions.staged}
                    onChange={(e) =>
                      onDiffOptionsChange({ ...diffOptions, staged: e.target.checked })
                    }
                  />
                  Show staged
                </label>
              )}
              {!customMode && !viewing && (
                <label className="settings-item">
                  <input
                    type="checkbox"
                    checked={diffOptions.untracked}
                    onChange={(e) =>
                      onDiffOptionsChange({ ...diffOptions, untracked: e.target.checked })
                    }
                  />
                  Show untracked
                </label>
              )}
              <label className="settings-item">
                <input
                  type="checkbox"
                  checked={softWrap}
                  onChange={(e) => onSoftWrapChange(e.target.checked)}
                />
                Soft wrap
              </label>
              <div className="settings-item settings-item-spaced">
                <span>Default tab size</span>
                <select
                  className="settings-select"
                  value={defaultTabSize}
                  onChange={(e) => onDefaultTabSizeChange(Number(e.target.value))}
                >
                  <option value={2}>2</option>
                  <option value={4}>4</option>
                  <option value={8}>8</option>
                </select>
              </div>
              <div className="settings-item settings-item-spaced">
                <span>Browser</span>
                <select
                  className="settings-select"
                  value={browser || ''}
                  onChange={(e) => {
                    onBrowserChange(e.target.value)
                    setSettingsOpen(false)
                  }}
                >
                  <option value="">Default</option>
                  <option value="chrome">Chrome</option>
                  <option value="firefox">Firefox</option>
                  <option value="edge">Edge</option>
                  <option value="brave">Brave</option>
                </select>
              </div>
            </div>
          )}
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleCopy}
          disabled={commentCount === 0}
        >
          {copied ? 'Copied!' : `Copy comments (${commentCount})`}
        </button>
      </div>
    </div>
  )
}
