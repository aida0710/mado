import { api } from '../api/client'

export function PreviewImage({ connId, bucket, k }: { connId: string; bucket: string; k: string }) {
  return <img className="prev-img" src={api.imageUrl(connId, bucket, k)} alt={k} />
}
