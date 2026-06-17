import { Routes, Route, useLocation } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Upload from './pages/Upload'
import Cleaning from './pages/Cleaning'
import Comparison from './pages/Comparison'
import Export from './pages/Export'
import FileEditor from './pages/FileEditor'

function App() {
  const location = useLocation();
  const isFullScreen = location.pathname.startsWith('/file-editor');

  return isFullScreen ? (
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
  )
}

export default App
