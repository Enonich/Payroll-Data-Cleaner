import { Link, useLocation } from 'react-router-dom';
import { 
  LayoutDashboard, 
  Upload, 
  Sparkles, 
  GitCompare, 
  Download,
  FileSpreadsheet
} from 'lucide-react';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/upload', label: 'Upload', icon: Upload },
  { path: '/cleaning', label: 'Cleaning', icon: Sparkles },
  { path: '/comparison', label: 'Compare', icon: GitCompare },
  { path: '/export', label: 'Export', icon: Download },
];

function getPageLabel(pathname) {
  if (pathname === '/' || pathname === '') return 'Dashboard';
  const item = navItems.find(n => n.path !== '/' && pathname.startsWith(n.path));
  return item?.label || 'Dashboard';
}

export default function Layout({ children }) {
  const location = useLocation();
  const pageLabel = getPageLabel(location.pathname);

  return (
    <div className="min-h-screen overflow-x-hidden" style={{ backgroundColor: '#fdfbf7' }}>
      {/* Header - always visible, shows app name + current page */}
      <header style={{ backgroundColor: 'rgba(255,255,255,0.85)', borderBottom: '1px solid var(--color-border)' }}
              className="fixed top-0 left-0 w-full z-20 backdrop-blur-md">
        <div className="px-5">
          <div className="flex items-center h-11 gap-3">
            <div className="flex items-center gap-2 shrink-0">
              <FileSpreadsheet className="h-4 w-4" style={{ color: 'var(--color-accent)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>
                Payroll Cleaner
              </span>
            </div>
            <span className="text-sm text-slate-400 font-light">/</span>
            <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {pageLabel}
            </span>
          </div>
        </div>
      </header>

      <div className="flex min-w-0">
        {/* Sidebar — fixed to viewport so scrolling doesn't affect it */}
        <aside className="fixed top-11 w-44 overflow-y-auto z-10"
               style={{ backgroundColor: '#fdfbf7', borderRight: '1px solid var(--color-border)', height: 'calc(100vh - 2.75rem)' }}>
          <nav className="p-2 space-y-0.5 pt-3">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.path ||
                (item.path !== '/' && location.pathname.startsWith(item.path));

              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors"
                  style={isActive
                    ? { backgroundColor: 'rgb(0 113 227 / 0.08)', color: 'var(--color-accent)', fontWeight: 500 }
                    : { color: 'var(--color-text-secondary)' }
                  }
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="text-sm">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* Main Content — left margin offsets the fixed sidebar width (w-44 = 11rem) */}
        <main className="flex-1 min-w-0 max-w-full p-5 pr-8 pt-14" style={{ marginLeft: '11rem' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
