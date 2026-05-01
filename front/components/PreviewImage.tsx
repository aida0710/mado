import { api } from '../api/client'

export function PreviewImage({ connId, bucket, k }: { connId: string; bucket: string; k: string }) {
  return (
    <img
      className="block h-auto max-w-full rounded-2"
      src={api.imageUrl(connId, bucket, k)}
      alt={k}
    />
  )
}
