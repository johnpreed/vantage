import { useState, useEffect, useRef } from 'react';
import { Save, Trash2, Plus, Eye, EyeOff, CheckCircle, XCircle, Download, Upload } from 'lucide-react';
import { verifyToken } from '../api/github';
import { clearAllData } from '../db';

// ============================================================================
// LocalStorage Keys
// ============================================================================

const STORAGE_KEYS = {
  PAT: 'vantage_github_pat',
  REPOSITORIES: 'vantage_repositories',
  TEAM_MEMBERS: 'vantage_team_members',
  AORS: 'vantage_aors',
  LOOKBACK_DAYS: 'vantage_lookback_days',
} as const;

// ============================================================================
// Types
// ============================================================================

export interface AreaOfResponsibility {
  id: string;
  name: string;
  terms: string[]; // List of matching terms/phrases
}

// ============================================================================
// Settings Helpers
// ============================================================================

export function getSettings() {
  return {
    pat: localStorage.getItem(STORAGE_KEYS.PAT) || '',
    repositories: JSON.parse(localStorage.getItem(STORAGE_KEYS.REPOSITORIES) || '[]') as string[],
    teamMembers: JSON.parse(localStorage.getItem(STORAGE_KEYS.TEAM_MEMBERS) || '[]') as string[],
    aors: JSON.parse(localStorage.getItem(STORAGE_KEYS.AORS) || '[]') as AreaOfResponsibility[],
    lookbackDays: parseInt(localStorage.getItem(STORAGE_KEYS.LOOKBACK_DAYS) || '180', 10),
  };
}

export function saveSettings(settings: {
  pat: string;
  repositories: string[];
  teamMembers: string[];
  aors: AreaOfResponsibility[];
  lookbackDays: number;
}) {
  localStorage.setItem(STORAGE_KEYS.PAT, settings.pat);
  localStorage.setItem(STORAGE_KEYS.REPOSITORIES, JSON.stringify(settings.repositories));
  localStorage.setItem(STORAGE_KEYS.TEAM_MEMBERS, JSON.stringify(settings.teamMembers));
  localStorage.setItem(STORAGE_KEYS.AORS, JSON.stringify(settings.aors));
  localStorage.setItem(STORAGE_KEYS.LOOKBACK_DAYS, settings.lookbackDays.toString());
}

// ============================================================================
// Settings Component
// ============================================================================

export function Settings() {
  const [pat, setPat] = useState('');
  const [showPat, setShowPat] = useState(false);
  const [patStatus, setPatStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
  const [patUser, setPatUser] = useState<string | null>(null);
  const [patError, setPatError] = useState<string | null>(null);

  const [repositories, setRepositories] = useState<string[]>([]);
  const [newRepo, setNewRepo] = useState('');

  const [teamMembers, setTeamMembers] = useState<string[]>([]);
  const [newMember, setNewMember] = useState('');

  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [newAorName, setNewAorName] = useState('');
  const [newAorTerms, setNewAorTerms] = useState('');

  const [lookbackDays, setLookbackDays] = useState(180);

  const [saved, setSaved] = useState(false);

  // Load settings on mount
  useEffect(() => {
    const settings = getSettings();
    setPat(settings.pat);
    setRepositories(settings.repositories);
    setTeamMembers(settings.teamMembers);
    setAors(settings.aors);
    setLookbackDays(settings.lookbackDays);

    // Verify existing PAT
    if (settings.pat) {
      verifyPat(settings.pat);
    }
  }, []);

  const verifyPat = async (token: string) => {
    if (!token) {
      setPatStatus('idle');
      return;
    }

    setPatStatus('checking');
    const result = await verifyToken(token);
    
    if (result.valid) {
      setPatStatus('valid');
      setPatUser(result.login || null);
      setPatError(null);
    } else {
      setPatStatus('invalid');
      setPatUser(null);
      setPatError(result.error || 'Invalid token');
    }
  };

  const handlePatChange = (value: string) => {
    setPat(value);
    setPatStatus('idle');
    setPatUser(null);
    setPatError(null);
  };

  const handleVerifyPat = () => {
    verifyPat(pat);
  };

  const handleAddRepo = () => {
    const trimmed = newRepo.trim();
    if (trimmed && trimmed.includes('/') && !repositories.includes(trimmed)) {
      setRepositories([...repositories, trimmed]);
      setNewRepo('');
    }
  };

  const handleRemoveRepo = (repo: string) => {
    setRepositories(repositories.filter(r => r !== repo));
  };

  const handleAddMember = () => {
    const trimmed = newMember.trim();
    if (trimmed && !teamMembers.includes(trimmed)) {
      setTeamMembers([...teamMembers, trimmed]);
      setNewMember('');
    }
  };

  const handleRemoveMember = (member: string) => {
    setTeamMembers(teamMembers.filter(m => m !== member));
  };

  const handleAddAor = () => {
    const name = newAorName.trim();
    const terms = newAorTerms
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0);
    
    if (name && terms.length > 0) {
      const newAor: AreaOfResponsibility = {
        id: `aor_${Date.now()}`,
        name,
        terms,
      };
      setAors([...aors, newAor]);
      setNewAorName('');
      setNewAorTerms('');
    }
  };

  const handleRemoveAor = (id: string) => {
    setAors(aors.filter(a => a.id !== id));
  };

  const handleSave = () => {
    saveSettings({ pat, repositories, teamMembers, aors, lookbackDays });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClearCache = async () => {
    if (confirm('Are you sure you want to clear all cached data? You will need to sync again.')) {
      await clearAllData();
      alert('Cache cleared successfully.');
    }
  };

  const handleExportSettings = () => {
    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        // Note: PAT is excluded for security
        repositories,
        teamMembers,
        aors,
        lookbackDays,
      },
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vantage-settings-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportSettings = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const importData = JSON.parse(content);

        if (!importData.settings) {
          alert('Invalid settings file: missing settings object');
          return;
        }

        const { settings } = importData;

        // Validate and import each setting
        if (Array.isArray(settings.repositories)) {
          setRepositories(settings.repositories);
        }
        if (Array.isArray(settings.teamMembers)) {
          setTeamMembers(settings.teamMembers);
        }
        if (Array.isArray(settings.aors)) {
          setAors(settings.aors);
        }
        if (typeof settings.lookbackDays === 'number') {
          setLookbackDays(settings.lookbackDays);
        }

        alert('Settings imported successfully! Click Save to persist them.');
      } catch (error) {
        alert('Failed to import settings: Invalid JSON file');
        console.error('Import error:', error);
      }
    };
    reader.readAsText(file);

    // Reset file input so same file can be imported again
    event.target.value = '';
  };

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Settings</h2>
        <p className="text-gray-400">Configure your GitHub connection and tracking preferences.</p>
      </div>

      {/* GitHub PAT */}
      <section className="bg-gray-900 rounded-lg p-6 border border-gray-800">
        <h3 className="text-lg font-semibold text-white mb-4">GitHub Personal Access Token</h3>
        <p className="text-sm text-gray-400 mb-4">
          Create a PAT with <code className="bg-gray-800 px-1 rounded">repo</code> and{' '}
          <code className="bg-gray-800 px-1 rounded">read:org</code> scopes.
        </p>
        
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showPat ? 'text' : 'password'}
              value={pat}
              onChange={(e) => handlePatChange(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 pr-10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            <button
              type="button"
              onClick={() => setShowPat(!showPat)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
            >
              {showPat ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <button
            onClick={handleVerifyPat}
            disabled={!pat || patStatus === 'checking'}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 rounded-lg text-sm font-medium transition-colors"
          >
            {patStatus === 'checking' ? 'Checking...' : 'Verify'}
          </button>
        </div>

        {/* PAT Status */}
        {patStatus === 'valid' && (
          <div className="mt-3 flex items-center gap-2 text-green-400">
            <CheckCircle size={16} />
            <span className="text-sm">Valid token for user: {patUser}</span>
          </div>
        )}
        {patStatus === 'invalid' && (
          <div className="mt-3 flex items-center gap-2 text-red-400">
            <XCircle size={16} />
            <span className="text-sm">{patError}</span>
          </div>
        )}
      </section>

      {/* Repositories */}
      <section className="bg-gray-900 rounded-lg p-6 border border-gray-800">
        <h3 className="text-lg font-semibold text-white mb-4">Repositories</h3>
        <p className="text-sm text-gray-400 mb-4">
          Add repositories to track in the format <code className="bg-gray-800 px-1 rounded">owner/repo</code>.
        </p>

        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={newRepo}
            onChange={(e) => setNewRepo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddRepo()}
            placeholder="microsoft/vscode"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <button
            onClick={handleAddRepo}
            disabled={!newRepo.trim() || !newRepo.includes('/')}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-800 disabled:text-gray-500 rounded-lg text-sm font-medium transition-colors"
          >
            <Plus size={18} />
          </button>
        </div>

        {repositories.length === 0 ? (
          <p className="text-gray-500 text-sm">No repositories added yet.</p>
        ) : (
          <ul className="space-y-2">
            {repositories.map((repo) => (
              <li
                key={repo}
                className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-2"
              >
                <span className="text-white">{repo}</span>
                <button
                  onClick={() => handleRemoveRepo(repo)}
                  className="text-gray-400 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Team Members */}
      <section className="bg-gray-900 rounded-lg p-6 border border-gray-800">
        <h3 className="text-lg font-semibold text-white mb-4">Team Members</h3>
        <p className="text-sm text-gray-400 mb-4">
          Add GitHub usernames of team members to track their activity.
        </p>

        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={newMember}
            onChange={(e) => setNewMember(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddMember()}
            placeholder="octocat"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <button
            onClick={handleAddMember}
            disabled={!newMember.trim()}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-800 disabled:text-gray-500 rounded-lg text-sm font-medium transition-colors"
          >
            <Plus size={18} />
          </button>
        </div>

        {teamMembers.length === 0 ? (
          <p className="text-gray-500 text-sm">No team members added yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {teamMembers.map((member) => (
              <span
                key={member}
                className="inline-flex items-center gap-2 bg-gray-800 rounded-full px-3 py-1"
              >
                <span className="text-white text-sm">@{member}</span>
                <button
                  onClick={() => handleRemoveMember(member)}
                  className="text-gray-400 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Lookback Period */}
      <section className="bg-gray-900 rounded-lg p-6 border border-gray-800">
        <h3 className="text-lg font-semibold text-white mb-4">Lookback Period</h3>
        <p className="text-sm text-gray-400 mb-4">
          How far back to look for team activity statistics (comments, closed issues, etc.).
        </p>

        <div className="flex items-center gap-4">
          <select
            value={lookbackDays}
            onChange={(e) => setLookbackDays(parseInt(e.target.value, 10))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          >
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days (3 months)</option>
            <option value={180}>180 days (6 months)</option>
            <option value={365}>365 days (1 year)</option>
          </select>
          <span className="text-gray-400 text-sm">Currently: {lookbackDays} days</span>
        </div>
      </section>

      {/* Areas of Responsibility */}
      <section className="bg-gray-900 rounded-lg p-6 border border-gray-800">
        <h3 className="text-lg font-semibold text-white mb-4">Areas of Responsibility (AoR)</h3>
        <p className="text-sm text-gray-400 mb-4">
          Define areas and their matching terms to track expertise. Terms are matched case-insensitively against issue titles.
        </p>

        {/* Add New AoR */}
        <div className="space-y-3 mb-4 p-4 bg-gray-800/50 rounded-lg border border-gray-700">
          <input
            type="text"
            value={newAorName}
            onChange={(e) => setNewAorName(e.target.value)}
            placeholder="AoR Name (e.g., Social SISU)"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <textarea
            value={newAorTerms}
            onChange={(e) => setNewAorTerms(e.target.value)}
            placeholder="Comma-separated terms (e.g., Google, Sign up, SISU, authentication)"
            rows={2}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
          />
          <button
            onClick={handleAddAor}
            disabled={!newAorName.trim() || !newAorTerms.trim()}
            className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-800 disabled:text-gray-500 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            <Plus size={16} />
            Add Area of Responsibility
          </button>
        </div>

        {/* Existing AoRs */}
        {aors.length === 0 ? (
          <p className="text-gray-500 text-sm">No areas of responsibility defined yet.</p>
        ) : (
          <div className="space-y-3">
            {aors.map((aor) => (
              <div
                key={aor.id}
                className="bg-gray-800 rounded-lg p-4 border border-gray-700"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h4 className="text-white font-medium mb-2">{aor.name}</h4>
                    <div className="flex flex-wrap gap-1">
                      {aor.terms.map((term, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-0.5 bg-gray-700 rounded text-xs text-gray-300"
                        >
                          {term}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemoveAor(aor.id)}
                    className="text-gray-400 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={handleClearCache}
            className="px-4 py-2 bg-red-900/50 hover:bg-red-900 text-red-300 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            <Trash2 size={16} />
            Clear Cache
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportSettings}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            <Download size={16} />
            Export
          </button>
          <button
            onClick={handleImportClick}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            <Upload size={16} />
            Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImportSettings}
            className="hidden"
          />
          <button
            onClick={handleSave}
            className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            <Save size={16} />
            {saved ? 'Saved!' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Settings;
