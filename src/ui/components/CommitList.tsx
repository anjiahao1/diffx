import { GitBranch } from 'lucide-react'
import type { RepoCommits } from '../hooks/useCommits'
import { timeAgo } from '../utils'

export interface SelectedCommit {
  repo?: string
  sha: string
}

interface CommitListProps {
  repoCommits: RepoCommits[]
  selected: SelectedCommit | null
  onSelect: (sel: SelectedCommit) => void
}

// Per-commit review: unpushed commits (@{u}..HEAD) grouped by repo. Clicking
// an entry switches the main view to that commit's diff.
export function CommitList({ repoCommits, selected, onSelect }: CommitListProps) {
  if (repoCommits.length === 0) return null
  return (
    <div className="commit-list">
      <div className="commit-list-header">Unpushed commits</div>
      {repoCommits.map((rc) => (
        <div key={rc.repo || '(repo)'} className="commit-group">
          <div className="commit-group-title">
            <span className="commit-group-repo">{rc.repo || rc.branch || '.'}</span>
            {rc.branch && (
              <span className="commit-group-branch">
                <GitBranch size={10} />
                {rc.branch}
              </span>
            )}
          </div>
          <ul className="commit-group-list">
            {rc.commits.map((c) => {
              const active = selected?.sha === c.sha && (selected?.repo ?? '') === rc.repo
              return (
                <li key={c.sha}>
                  <button
                    className={`commit-item ${active ? 'commit-item-active' : ''}`}
                    onClick={() => onSelect({ repo: rc.repo || undefined, sha: c.sha })}
                    title={c.subject}
                  >
                    <span className="commit-sha">{c.sha.slice(0, 7)}</span>
                    <span className="commit-subject">{c.subject}</span>
                    <span className="commit-date">{timeAgo(new Date(c.date).getTime())}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
