import { mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ClifyError, nodeErrorCode } from './errors.js'

interface LockOptions {
  readonly timeoutMs?: number
  readonly staleMs?: number
  readonly onWait?: (elapsedMs: number) => void
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const started = Date.now()
  let announced = false
  await mkdir(dirname(lockPath), { recursive: true })

  while (true) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(`${process.pid}\n`)
        return await fn()
      } finally {
        await handle.close()
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error
      const elapsed = Date.now() - started
      if (!announced) {
        options.onWait?.(elapsed)
        announced = true
      }
      if (elapsed > timeoutMs)
        throw new ClifyError('INSTALL_TIMEOUT', `could not acquire lock ${lockPath}`)
      await delay(100)
    }
  }
}
