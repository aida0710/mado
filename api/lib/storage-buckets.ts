import { ListBucketsCommand } from '@aws-sdk/client-s3'
import type { GetStorage } from '../routes/_connectionId.js'

/** 容量画面と定期schedulerで共有する、cacheを介さないbucket名一覧。 */
export async function listStorageBucketNames(getStorage: GetStorage, connectionId: string): Promise<string[]> {
  const storage = await getStorage(connectionId)
  const result = await storage.send(new ListBucketsCommand({}))
  return (result.Buckets ?? [])
    .flatMap(bucket => bucket.Name ? [bucket.Name] : [])
    .sort((a, b) => a.localeCompare(b))
}
