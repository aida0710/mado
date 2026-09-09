import type { CapacityStore } from './capacity-store.js'
import type { JobStore } from './jobs.js'
import type { ConnectionConfig } from '../storage.js'
import { SCAN_KIND, scanDedupKey } from '../routes/storage-scan.js'

export interface CapacitySchedulerDeps {
  capacity: Pick<CapacityStore, 'reserveDue' | 'attachJob' | 'markPaused' | 'recordError'>
  jobs: Pick<JobStore, 'enqueueWithResult'>
  getConnectionConfig: (connectionId: string) => Promise<ConnectionConfig>
  batchSize?: number
}

export function createCapacityScheduler(deps: CapacitySchedulerDeps): { runOnce(): Promise<number> } {
  return {
    async runOnce() {
      const due = await deps.capacity.reserveDue(deps.batchSize ?? 20)
      for (const item of due) {
        try {
          const config = await deps.getConnectionConfig(item.connectionId)
          if (!config.scanEnabled) {
            await deps.capacity.markPaused(item.connectionId, item.bucket)
            continue
          }
          const job = await deps.jobs.enqueueWithResult(
            SCAN_KIND,
            scanDedupKey(item.connectionId, item.bucket, ''),
            { connId: item.connectionId, bucket: item.bucket, prefix: '' },
          )
          await deps.capacity.attachJob(item.connectionId, item.bucket, job.id)
        } catch (error) {
          await deps.capacity.recordError(item.connectionId, item.bucket, error)
        }
      }
      return due.length
    },
  }
}
