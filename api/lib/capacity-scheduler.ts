import type { CapacityStore } from './capacity-store.js'
import type { JobStore } from './jobs.js'
import type { ConnectionConfig } from '../storage.js'
import { SCAN_KIND, scanDedupKey } from '../routes/storage-scan.js'

type CapacityJobDeps = {
  capacity: Pick<CapacityStore, 'syncBuckets' | 'attachJob'>
  jobs: Pick<JobStore, 'enqueueWithResult'>
}

export interface CapacityJob {
  bucket: string
  jobId: number
  created: boolean
}

/** connection配下の全bucketを1回の操作で投入する。個別設定・個別実行は持たない。 */
export async function enqueueCapacityScans(
  deps: CapacityJobDeps,
  connectionId: string,
  bucketNames: string[],
): Promise<CapacityJob[]> {
  const buckets = [...new Set(bucketNames)]
  await deps.capacity.syncBuckets(connectionId, buckets)
  const queued: CapacityJob[] = []
  for (const bucket of buckets) {
    const job = await deps.jobs.enqueueWithResult(
      SCAN_KIND,
      scanDedupKey(connectionId, bucket, ''),
      { connectionId, bucket, prefix: '' },
    )
    await deps.capacity.attachJob(connectionId, bucket, job.id)
    queued.push({ bucket, jobId: job.id, created: job.created })
  }
  return queued
}

export interface CapacitySchedulerDeps extends CapacityJobDeps {
  capacity: CapacityJobDeps['capacity'] & Pick<CapacityStore,
    'reserveDueConnections' | 'markConnectionScheduled' | 'markConnectionPaused' | 'recordConnectionError'>
  getConnectionConfig: (connectionId: string) => Promise<ConnectionConfig>
  listBuckets: (connectionId: string) => Promise<string[]>
  batchSize?: number
}

export function createCapacityScheduler(deps: CapacitySchedulerDeps): { runOnce(): Promise<number> } {
  return {
    async runOnce() {
      const due = await deps.capacity.reserveDueConnections(deps.batchSize ?? 5)
      for (const connectionId of due) {
        try {
          const config = await deps.getConnectionConfig(connectionId)
          if (!config.scanEnabled || !config.capacityMetricsEnabled) {
            await deps.capacity.markConnectionPaused(connectionId)
            continue
          }
          const buckets = await deps.listBuckets(connectionId)
          await enqueueCapacityScans(deps, connectionId, buckets)
          await deps.capacity.markConnectionScheduled(connectionId)
        } catch (error) {
          await deps.capacity.recordConnectionError(connectionId, error)
        }
      }
      return due.length
    },
  }
}
