import { api } from '../api/client'

export function PreviewAudio({ bucket, k }: { bucket: string; k: string }) {
  return (
    <audio
      className="prev-audio"
      src={api.audioUrl(bucket, k)}
      controls
      preload="metadata"
    />
  )
}
