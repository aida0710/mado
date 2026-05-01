import { api } from '../lib/api/client'

export function PreviewAudio({ connId, bucket, k }: { connId: string; bucket: string; k: string }) {
  return (
    <audio
      className="w-full"
      src={api.audioUrl(connId, bucket, k)}
      controls
      preload="metadata"
    />
  )
}
