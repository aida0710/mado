import { Route, Routes } from 'react-router-dom'
import S3Index from './S3Index'
import S3Bucket from './S3Bucket'

export default function S3Page() {
  return (
    <Routes>
      <Route path="/"          element={<S3Index  />} />
      <Route path=":bucket/*"  element={<S3Bucket />} />
    </Routes>
  )
}
