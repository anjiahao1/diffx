import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CommentStore } from './comments.js'
import type { ReviewComment } from './types.js'

export interface PatchsetEntry {
  savedAt: number
  // Per-file blob oids captured from the commit patch's index lines. Only
  // oids are stored — the diff itself is reproducible from git on demand.
  files: Record<string, { oldOid: string; newOid: string }>
}

// Review state persisted under ~/.diffx/cache/<workspaceRootWithSlashesAsDashes>/.
// Comments survive server restarts; patchset snapshots anchor comments to the
// exact blob versions they were made on.
export class ReviewCache {
  private dir: string

  constructor(workspaceRoot: string) {
    // ponytail: slash-to-dash mangling is ambiguous (/a-b/c vs /a/b-c collide);
    // fine for a local cache, hash the path if it ever matters.
    const mangled = workspaceRoot.replaceAll('/', '-')
    this.dir = join(homedir(), '.diffx', 'cache', mangled)
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      // cache unwritable — everything degrades to in-memory
    }
  }

  loadComments(): ReviewComment[] | null {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, 'comments.json'), 'utf-8'))
      return Array.isArray(parsed) ? (parsed as ReviewComment[]) : null
    } catch {
      return null
    }
  }

  saveComments(comments: ReviewComment[]): void {
    try {
      writeFileSync(join(this.dir, 'comments.json'), JSON.stringify(comments, null, 2))
    } catch (err) {
      console.warn('diffx: failed to persist comments:', err instanceof Error ? err.message : err)
    }
  }

  // Note to the reviewing agent, sent ahead of the comments when copied.
  loadAiNote(): string {
    try {
      return readFileSync(join(this.dir, 'ai-note.txt'), 'utf-8')
    } catch {
      return ''
    }
  }

  saveAiNote(note: string): void {
    try {
      writeFileSync(join(this.dir, 'ai-note.txt'), note)
    } catch (err) {
      console.warn('diffx: failed to persist ai note:', err instanceof Error ? err.message : err)
    }
  }

  private loadPatchsets(): Record<string, PatchsetEntry> {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, 'patchsets.json'), 'utf-8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  private savePatchsets(map: Record<string, PatchsetEntry>): void {
    try {
      writeFileSync(join(this.dir, 'patchsets.json'), JSON.stringify(map, null, 2))
    } catch (err) {
      console.warn('diffx: failed to persist patchsets:', err instanceof Error ? err.message : err)
    }
  }

  getPatchset(repo: string, sha: string): PatchsetEntry | undefined {
    return this.loadPatchsets()[`${repo}\0${sha}`]
  }

  savePatchset(repo: string, sha: string, files: PatchsetEntry['files']): void {
    const map = this.loadPatchsets()
    map[`${repo}\0${sha}`] = { savedAt: Date.now(), files }
    this.savePatchsets(map)
  }
}

// CommentStore decorator that writes every mutation through to disk.
export class PersistedCommentStore implements CommentStore {
  constructor(
    private inner: CommentStore,
    private cache: ReviewCache,
  ) {}

  private async persist(): Promise<void> {
    this.cache.saveComments(await this.inner.getAll())
  }

  async getAll(): Promise<ReviewComment[]> {
    return this.inner.getAll()
  }

  async add(comment: ReviewComment): Promise<ReviewComment> {
    const created = await this.inner.add(comment)
    await this.persist()
    return created
  }

  async update(id: string, fields: { body?: string; status?: ReviewComment['status'] }): Promise<ReviewComment | null> {
    const updated = await this.inner.update(id, fields)
    if (updated) await this.persist()
    return updated
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.inner.remove(id)
    if (removed) await this.persist()
    return removed
  }

  async addReply(commentId: string, reply: ReviewComment['replies'][number]): Promise<ReviewComment | null> {
    const updated = await this.inner.addReply(commentId, reply)
    if (updated) await this.persist()
    return updated
  }
}
