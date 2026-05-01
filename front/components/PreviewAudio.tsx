import { api } from '../api/client'

export function PreviewAudio({ connId, bucket, k }: { connId: string; bucket: string; k: string }) {
  return (
    <audio
      className="prev-audio"
      src={api.audioUrl(connId, bucket, k)}
      controls
      preload="metadata"
    />
  )
}
