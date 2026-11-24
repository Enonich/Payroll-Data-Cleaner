import { lazy, Suspense } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import Layout from './components/Layout'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Upload = lazy(() => import('./pages/Upload'))
const Cleaning = lazy(() => import('./pages/Cleaning'))
const Comparison = lazy(() => import('./pages/Comparison'))
const Export = lazy(() => import('./pages/Export'))
const FileEditor = lazy(() => import('./pages/FileEditor'))

const PageLoader = () => (
  <div className="flex items-center justify-center min-h-[400px]">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
  </div>
)

function App() {
  const location = useLocation();
  const isFullScreen = location.pathname.startsWith('/file-editor');

  return (
    <Suspense fallback={<PageLoader />}>
      {isFullScreen ? (
        <Routes>
          <Route path="/file-editor/:fileId" element={<FileEditor />} />
        </Routes>
      ) : (
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/upload" element={<Upload />} />
            <Route path="/cleaning/:fileId?" element={<Cleaning />} />
            <Route path="/comparison" element={<Comparison />} />
            <Route path="/export" element={<Export />} />
          </Routes>
        </Layout>
      )}
    </Suspense>
  )
}

export default App

