import { api } from '../lib/api/client'

export function PreviewImage({ connectionId, bucket, k }: { connectionId: string; bucket: string; k: string }) {
  return (
    <img
      className="block h-auto max-w-full"
      style={{
        borderRadius: 'var(--radius-2)',
        border: '1px solid var(--rule)',
        boxShadow: '0 1px 4px rgba(10, 9, 4, 0.06)',
      }}
      src={api.imageUrl(connectionId, bucket, k)}
      alt={k}
    />
  )
}
