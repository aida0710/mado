import { api } from '../lib/api/client'

export function PreviewImage({ connectionId, bucket, k }: { connectionId: string; bucket: string; k: string }) {
  return <img className="preview-image" src={api.imageUrl(connectionId, bucket, k)} alt={k} />
}
