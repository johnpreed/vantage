import { useState, useCallback } from 'react';
import { Layout, type TabId } from './components/Layout';
import { OpenIssuesView } from './components/OpenIssuesView';
import { TeamView } from './components/TeamView';
import { Settings, getSettings } from './components/Settings';
import { syncAllRepositories, parseSearchQuery } from './api/github';
import { db, clearAllData } from './db';
import { useLiveQuery } from 'dexie-react-hooks';

const DEFAULT_FILTER = 'label:support-escalation';

function App() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(DEFAULT_FILTER);

  // Get last sync time from IndexedDB
  const syncStatus = useLiveQuery(() => db.syncStatus.get('global'));
  const lastSync = syncStatus?.lastFullSync || null;

  const handleSync = useCallback(async () => {
    const settings = getSettings();

    if (!settings.pat) {
      alert('Please configure your GitHub PAT in Settings first.');
      return;
    }

    if (settings.repositories.length === 0) {
      alert('Please add at least one repository in Settings first.');
      return;
    }

    setIsSyncing(true);
    setSyncMessage('Starting sync...');

    try {
      // Clear existing data before sync with new filter
      await clearAllData();
      
      // Parse the search query into filter options
      const filter = parseSearchQuery(searchQuery);
      
      await syncAllRepositories(
        settings.pat,
        settings.repositories,
        settings.teamMembers,
        (message) => setSyncMessage(message),
        filter
      );
      setSyncMessage('Sync complete!');
      setTimeout(() => setSyncMessage(null), 3000);
    } catch (error) {
      console.error('Sync failed:', error);
      setSyncMessage(`Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsSyncing(false);
    }
  }, [searchQuery]);

  const renderTab = (activeTab: TabId) => {
    switch (activeTab) {
      case 'focus':
        return <OpenIssuesView />;
      case 'team':
        return <TeamView />;
      case 'settings':
        return <Settings />;
      default:
        return <OpenIssuesView />;
    }
  };

  return (
    <>
      <Layout
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        syncStatus={{
          isSyncing,
          lastSync,
          onSync: handleSync,
        }}
      >
        {renderTab}
      </Layout>

      {/* Sync Status Toast */}
      {syncMessage && (
        <div className="fixed bottom-4 right-4 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 shadow-lg max-w-md">
          <p className="text-sm text-white">{syncMessage}</p>
        </div>
      )}
    </>
  );
}

export default App;
