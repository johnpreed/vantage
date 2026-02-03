import { useState, type ReactNode } from 'react';
import { 
  Focus, 
  Users, 
  Settings, 
  Database,
  Search,
  RefreshCw
} from 'lucide-react';

export type TabId = 'focus' | 'team' | 'settings';

interface Tab {
  id: TabId;
  label: string;
  icon: ReactNode;
}

const tabs: Tab[] = [
  { id: 'focus', label: 'Open Issues', icon: <Focus size={18} /> },
  { id: 'team', label: 'Team View', icon: <Users size={18} /> },
  { id: 'settings', label: 'Settings', icon: <Settings size={18} /> },
];

interface LayoutProps {
  children: (activeTab: TabId) => ReactNode;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  syncStatus: {
    isSyncing: boolean;
    lastSync: string | null;
    onSync: () => void;
  };
}

export function Layout({ children, searchQuery, onSearchChange, syncStatus }: LayoutProps) {
  const [activeTab, setActiveTab] = useState<TabId>('focus');

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <Database className="h-8 w-8 text-indigo-500" />
              <h1 className="text-xl font-bold text-white">Vantage</h1>
            </div>

            {/* Global Search & Sync */}
            <div className="flex items-center gap-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder="Filter: label:, repo:, author:, assignee:"
                  className="w-80 bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
              
              {syncStatus.lastSync && (
                <span className="text-xs text-gray-500">
                  {new Date(syncStatus.lastSync).toLocaleString()}
                </span>
              )}
              
              <button
                onClick={syncStatus.onSync}
                disabled={syncStatus.isSyncing}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-800 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
              >
                <RefreshCw size={16} className={syncStatus.isSyncing ? 'animate-spin' : ''} />
                {syncStatus.isSyncing ? 'Syncing...' : 'Sync'}
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Tab Navigation */}
      <nav className="border-b border-gray-800 bg-gray-900/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  flex items-center gap-2 px-4 py-3 text-sm font-medium rounded-t-lg transition-colors
                  ${activeTab === tab.id
                    ? 'bg-gray-800 text-white border-b-2 border-indigo-500'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
                  }
                `}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {children(activeTab)}
      </main>
    </div>
  );
}

export default Layout;
