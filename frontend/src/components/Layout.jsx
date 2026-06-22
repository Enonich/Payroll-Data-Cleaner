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

export default function Layout({ children }) {
  const location = useLocation();

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--color-surface)' }}>
      {/* Header */}
      <header style={{ backgroundColor: 'rgba(255,255,255,0.85)', borderBottom: '1px solid var(--color-border)' }}
              className="sticky top-0 z-20 backdrop-blur-md">
        <div className="px-5">
          <div className="flex items-center h-11">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4" style={{ color: 'var(--color-accent)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>
                Payroll Cleaner
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside className="sticky top-11 self-start w-44 shrink-0 overflow-y-auto"
               style={{ backgroundColor: 'var(--color-card)', borderRight: '1px solid var(--color-border)', maxHeight: 'calc(100vh - 2.75rem)' }}>
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

        {/* Main Content */}
        <main className="flex-1 p-5 pr-8">
          {children}
        </main>
      </div>
    </div>
  );
}
