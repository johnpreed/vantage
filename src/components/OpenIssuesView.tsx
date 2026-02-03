import { useMemo, useState, useEffect } from 'react';
import { ExternalLink, GitPullRequest, Tag, MessageSquare, Users, Clock, HelpCircle } from 'lucide-react';
import { db, type Issue, getBatchIssueEngagedMembers, getBatchCommentCounts, getBatchIssueStatus, type IssueStatus } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { getSettings } from './Settings';

export function OpenIssuesView() {
  // Live query only OPEN issues
  const allIssues = useLiveQuery(() => db.issues.where('state').equals('OPEN').toArray(), []);
  const [engagedMembersMap, setEngagedMembersMap] = useState<Map<number, string[]>>(new Map());
  const [commentCountsMap, setCommentCountsMap] = useState<Map<number, number>>(new Map());
  const [issueStatusMap, setIssueStatusMap] = useState<Map<number, IssueStatus>>(new Map());

  // Sort by updated date descending
  const sortedIssues = useMemo(() => {
    if (!allIssues) return [];
    return [...allIssues].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }, [allIssues]);

  // Load engaged team members for all issues
  useEffect(() => {
    if (!allIssues || allIssues.length === 0) return;
    
    const settings = getSettings();
    const teamMembers = settings.teamMembers;
    
    if (teamMembers.length === 0) {
      setEngagedMembersMap(new Map());
      return;
    }
    
    const issueIds = allIssues.map(i => i.id);
    getBatchIssueEngagedMembers(issueIds, teamMembers).then(setEngagedMembersMap);
  }, [allIssues]);

  // Load comment counts for all issues
  useEffect(() => {
    if (!allIssues || allIssues.length === 0) return;
    
    const issueIds = allIssues.map(i => i.id);
    getBatchCommentCounts(issueIds).then(setCommentCountsMap);
  }, [allIssues]);

  // Load issue status (stalled, awaiting reply)
  useEffect(() => {
    if (!allIssues || allIssues.length === 0) return;
    
    const settings = getSettings();
    const teamMembers = settings.teamMembers;
    
    const issueIds = allIssues.map(i => i.id);
    getBatchIssueStatus(issueIds, teamMembers).then(setIssueStatusMap);
  }, [allIssues]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Open Issues</h2>
        <p className="text-gray-400">
          Showing {sortedIssues.length} open issues matching current filter.
        </p>
      </div>

      {/* Issues List */}
      <div className="space-y-3">
        {allIssues === undefined && (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        )}

        {sortedIssues.length === 0 && allIssues !== undefined && (
          <div className="text-center py-12 text-gray-500">
            No open issues found. Configure filter and sync data.
          </div>
        )}

        {sortedIssues.map((issue) => (
          <IssueCard
            key={issue.id}
            issue={issue}
            formatDate={formatDate}
            engagedMembers={engagedMembersMap.get(issue.id) || []}
            commentCount={commentCountsMap.get(issue.id) || 0}
            status={issueStatusMap.get(issue.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface IssueCardProps {
  issue: Issue;
  formatDate: (date: string) => string;
  engagedMembers: string[];
  commentCount: number;
  status?: IssueStatus;
}

function IssueCard({ issue, formatDate, engagedMembers, commentCount, status }: IssueCardProps) {
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 hover:border-gray-700 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* Title and Number */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-gray-500 text-sm">#{issue.number}</span>
            <a
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-indigo-400 transition-colors"
            >
              <ExternalLink size={14} />
            </a>
            {status?.isStalled && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-500/20 text-amber-400 border border-amber-500/40">
                <Clock size={10} />
                Stalled
              </span>
            )}
            {status?.isAwaitingReply && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-rose-500/20 text-rose-400 border border-rose-500/40">
                <HelpCircle size={10} />
                Awaiting Reply
              </span>
            )}
          </div>

          <h3 className="text-white font-medium mb-2 truncate">{issue.title}</h3>

          {/* Meta Info */}
          <div className="flex items-center gap-4 text-sm text-gray-400">
            <span>{issue.repository}</span>
            <span>by {issue.author}</span>
            <span>updated {formatDate(issue.updatedAt)}</span>
            {engagedMembers.length > 0 ? (
              <span className="flex items-center gap-1 text-indigo-400">
                <Users size={12} />
                {engagedMembers.join(', ')}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-gray-600">
                <Users size={12} />
                No team
              </span>
            )}
          </div>

          {/* Labels */}
          {issue.labels.length > 0 && (
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <Tag size={14} className="text-gray-500" />
              {issue.labels.slice(0, 5).map((label) => (
                <span
                  key={label.id}
                  className="px-2 py-0.5 rounded-full text-xs"
                  style={{
                    backgroundColor: `#${label.color}20`,
                    color: `#${label.color}`,
                    border: `1px solid #${label.color}40`,
                  }}
                >
                  {label.name}
                </span>
              ))}
              {issue.labels.length > 5 && (
                <span className="text-gray-500 text-xs">+{issue.labels.length - 5} more</span>
              )}
            </div>
          )}

          {/* Assignees */}
          {issue.assignees.length > 0 && (
            <div className="mt-2 text-sm text-gray-400">
              Assigned to: {issue.assignees.join(', ')}
            </div>
          )}
        </div>

        {/* Right Side Stats */}
        <div className="flex flex-col items-end gap-2 text-gray-400">
          {issue.linkedPRs.length > 0 && (
            <div className="flex items-center gap-1 text-sm">
              <GitPullRequest size={14} />
              <span>{issue.linkedPRs.length}</span>
            </div>
          )}
          <div className="flex items-center gap-1 text-sm">
            <MessageSquare size={14} />
            <span>{commentCount}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default OpenIssuesView;
