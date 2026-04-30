import { api } from '../api/client'

export function PreviewImage({ bucket, k }: { bucket: string; k: string }) {
  return <img className="prev-img" src={api.imageUrl(bucket, k)} alt={k} />
}
