import { useState, useEffect } from 'react';
import { MessageSquare, CheckCircle, GitPullRequest, AlertTriangle, ExternalLink, User, Clock, Target, HelpCircle, CircleDot } from 'lucide-react';
import { db, getTeamMemberStats, getMemberEngagedIssues, calculateAorExpertise, getBatchIssueStatus, type Issue, type IssueStatus } from '../db';
import { getSettings, type AreaOfResponsibility } from './Settings';

interface TeamMemberStats {
  username: string;
  comments: number;
  issuesClosed: number;
  linkedPRsCount: number;
  engagedIssuesCount: number;
  openIssuesCount: number;
  stalledIssuesCount: number;
  awaitingReplyCount: number;
}

type DetailTab = 'stalled' | 'engaged' | 'prs' | 'expertise';

interface AorExpertiseData {
  aor: AreaOfResponsibility;
  count: number;
  issues: Issue[];
}

export function TeamView() {
  const [stats, setStats] = useState<TeamMemberStats[]>([]);
  const [memberStalledIssues, setMemberStalledIssues] = useState<Map<string, Issue[]>>(new Map());
  const [issueStatusMap, setIssueStatusMap] = useState<Map<number, IssueStatus>>(new Map());
  const [engagedIssues, setEngagedIssues] = useState<Issue[]>([]);
  const [aorExpertise, setAorExpertise] = useState<AorExpertiseData[]>([]);
  const [issuesWithMemberPRs, setIssuesWithMemberPRs] = useState<Issue[]>([]);
  const [memberLinkedPRsCount, setMemberLinkedPRsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingEngaged, setLoadingEngaged] = useState(false);
  const [selectedMember, setSelectedMember] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('stalled');
  const [expandedAor, setExpandedAor] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'comments' | 'issuesClosed' | 'linkedPRsCount' | 'engagedIssuesCount' | 'openIssuesCount' | 'stalledIssuesCount'>('comments');
  const [lookbackDays, setLookbackDays] = useState(180);

  useEffect(() => {
    loadTeamStats();
  }, []);

  // Load engaged issues when a member is selected
  useEffect(() => {
    if (selectedMember) {
      setLoadingEngaged(true);
      
      Promise.all([
        getMemberEngagedIssues(selectedMember),
        db.issues.toArray() // Get all issues to find linked PRs
      ])
        .then(async ([engaged, allIssues]) => {
          setEngagedIssues(engaged);
          
          // Get ALL issues where member has authored linked PRs (for consistency with table count)
          const issuesWithPRs = allIssues.filter(issue =>
            issue.linkedPRs.some(pr => pr.author === selectedMember)
          );
          setIssuesWithMemberPRs(issuesWithPRs);
          
          // Count total linked PRs by this member across ALL issues
          let totalLinkedPRs = 0;
          for (const issue of allIssues) {
            totalLinkedPRs += issue.linkedPRs.filter(pr => pr.author === selectedMember).length;
          }
          setMemberLinkedPRsCount(totalLinkedPRs);
          
          // Get issue status for engaged issues + issues with PRs
          const settings = getSettings();
          const allRelevantIssueIds = new Set([
            ...engaged.map(i => i.id),
            ...issuesWithPRs.map(i => i.id)
          ]);
          const statusMap = await getBatchIssueStatus(Array.from(allRelevantIssueIds), settings.teamMembers);
          setIssueStatusMap(statusMap);
          
          // Calculate AoR expertise
          if (settings.aors.length > 0) {
            const expertiseMap = calculateAorExpertise(engaged, settings.aors);
            const expertiseData: AorExpertiseData[] = settings.aors.map(aor => ({
              aor,
              count: expertiseMap.get(aor.id)?.count || 0,
              issues: expertiseMap.get(aor.id)?.issues || [],
            }));
            // Sort by count descending
            expertiseData.sort((a, b) => b.count - a.count);
            setAorExpertise(expertiseData);
          } else {
            setAorExpertise([]);
          }
          
          setLoadingEngaged(false);
        })
        .catch(error => {
          console.error('Failed to load engaged issues:', error);
          setLoadingEngaged(false);
        });
    } else {
      setEngagedIssues([]);
      setAorExpertise([]);
      setExpandedAor(null);
      setIssueStatusMap(new Map());
      setIssuesWithMemberPRs([]);
      setMemberLinkedPRsCount(0);
    }
  }, [selectedMember]);

  const handleMemberClick = (username: string) => {
    if (selectedMember === username) {
      setSelectedMember(null);
    } else {
      setSelectedMember(username);
      setDetailTab('stalled'); // Reset to stalled tab when selecting new member
      setExpandedAor(null);
    }
  };

  const loadTeamStats = async () => {
    setLoading(true);
    try {
      const settings = getSettings();
      const { teamMembers } = settings;

      if (teamMembers.length === 0) {
        setStats([]);
        setLoading(false);
        return;
      }

      setLookbackDays(settings.lookbackDays);

      // Get member stats
      const memberStats = await getTeamMemberStats(teamMembers, settings.lookbackDays);

      // Get all issues for total engaged count
      const allIssues = await db.issues.toArray();
      
      // Get all comments to determine engagement
      const allComments = await db.comments.toArray();
      const commentsByIssueAll = new Map<number, string[]>();
      for (const comment of allComments) {
        if (!commentsByIssueAll.has(comment.issueId)) {
          commentsByIssueAll.set(comment.issueId, []);
        }
        commentsByIssueAll.get(comment.issueId)!.push(comment.author);
      }
      
      // Count total engaged issues per member
      const memberEngagedIssues = new Map<string, number>();
      for (const member of teamMembers) {
        memberEngagedIssues.set(member, 0);
      }
      
      for (const issue of allIssues) {
        const commenters = commentsByIssueAll.get(issue.id) || [];
        const engagedMembers = new Set<string>();
        
        for (const assignee of issue.assignees) {
          if (teamMembers.includes(assignee)) {
            engagedMembers.add(assignee);
          }
        }
        for (const commenter of commenters) {
          if (teamMembers.includes(commenter)) {
            engagedMembers.add(commenter);
          }
        }
        
        for (const member of engagedMembers) {
          memberEngagedIssues.set(member, (memberEngagedIssues.get(member) || 0) + 1);
        }
      }

      // Get all open issues for stalled/awaiting counts
      const openIssues = allIssues.filter(i => i.state === 'OPEN');
      const issueIds = openIssues.map(i => i.id);
      
      // Get status for all open issues
      const statusMap = await getBatchIssueStatus(issueIds, teamMembers);
      
      // Get comments for open issues to determine stalled/awaiting
      const openIssueComments = allComments.filter(c => issueIds.includes(c.issueId));
      const commentsByIssue = new Map<number, string[]>();
      for (const comment of openIssueComments) {
        if (!commentsByIssue.has(comment.issueId)) {
          commentsByIssue.set(comment.issueId, []);
        }
        commentsByIssue.get(comment.issueId)!.push(comment.author);
      }
      
      // Build map of member -> stalled issues (issues they're assigned to or commented on)
      const memberStalled = new Map<string, Issue[]>();
      const memberAwaiting = new Map<string, number>();
      const memberOpenIssues = new Map<string, number>();
      
      for (const member of teamMembers) {
        memberStalled.set(member, []);
        memberAwaiting.set(member, 0);
        memberOpenIssues.set(member, 0);
      }
      
      for (const issue of openIssues) {
        const status = statusMap.get(issue.id);
        if (!status) continue;
        
        // Find engaged team members for this issue
        const commenters = commentsByIssue.get(issue.id) || [];
        const engagedMembers = new Set<string>();
        
        for (const assignee of issue.assignees) {
          if (teamMembers.includes(assignee)) {
            engagedMembers.add(assignee);
          }
        }
        for (const commenter of commenters) {
          if (teamMembers.includes(commenter)) {
            engagedMembers.add(commenter);
          }
        }
        
        // Attribute stalled/awaiting to engaged members
        for (const member of engagedMembers) {
          // Count open issues
          memberOpenIssues.set(member, (memberOpenIssues.get(member) || 0) + 1);
          
          if (status.isStalled) {
            memberStalled.get(member)!.push(issue);
          }
          if (status.isAwaitingReply) {
            memberAwaiting.set(member, (memberAwaiting.get(member) || 0) + 1);
          }
        }
      }
      
      setMemberStalledIssues(memberStalled);

      // Combine into stats array
      const combinedStats: TeamMemberStats[] = teamMembers.map((username) => {
        const memberData = memberStats.get(username) || { comments: 0, issuesClosed: 0, linkedPRsCount: 0 };
        return {
          username,
          ...memberData,
          engagedIssuesCount: memberEngagedIssues.get(username) || 0,
          openIssuesCount: memberOpenIssues.get(username) || 0,
          stalledIssuesCount: memberStalled.get(username)?.length || 0,
          awaitingReplyCount: memberAwaiting.get(username) || 0,
        };
      });

      setStats(combinedStats);
    } catch (error) {
      console.error('Failed to load team stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const sortedStats = [...stats].sort((a, b) => b[sortBy] - a[sortBy]);

  const getStatColor = (value: number, type: 'good' | 'warning') => {
    if (type === 'warning') {
      if (value === 0) return 'text-green-400';
      if (value <= 2) return 'text-amber-400';
      return 'text-red-400';
    }
    return 'text-indigo-400';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-500">Loading team stats...</div>
      </div>
    );
  }

  if (stats.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">Team View</h2>
          <p className="text-gray-400">Track team member activity and engagement.</p>
        </div>
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-8 text-center">
          <User className="mx-auto mb-4 text-gray-600" size={48} />
          <p className="text-gray-400">No team members configured.</p>
          <p className="text-gray-500 text-sm mt-2">
            Add team members in Settings to see their activity.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Team View</h2>
        <p className="text-gray-400">Track team member activity and engagement over the last {lookbackDays} days.</p>
      </div>

      {/* Sort Controls */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-400">Sort by:</span>
        <div className="flex gap-2">
          {[
            { key: 'comments', label: 'Comments', icon: MessageSquare },
            { key: 'issuesClosed', label: 'Closer', icon: CheckCircle },
            { key: 'linkedPRsCount', label: 'Linked PRs', icon: GitPullRequest },
            { key: 'engagedIssuesCount', label: 'Engaged', icon: MessageSquare },
            { key: 'openIssuesCount', label: 'Open Issues', icon: CircleDot },
            { key: 'stalledIssuesCount', label: 'Stalled Issues', icon: AlertTriangle },
          ].map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setSortBy(key as typeof sortBy)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                sortBy === key
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Leaderboard */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-400">Rank</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-400">Team Member</th>
              <th className="text-center px-6 py-4 text-sm font-medium text-gray-400">
                <div className="flex items-center justify-center gap-2">
                  <MessageSquare size={14} />
                  Comments
                </div>
              </th>
              <th className="text-center px-6 py-4 text-sm font-medium text-gray-400">
                <div className="flex items-center justify-center gap-2">
                  <CheckCircle size={14} />
                  Closer
                </div>
              </th>
              <th className="text-center px-6 py-4 text-sm font-medium text-gray-400">
                <div className="flex items-center justify-center gap-2">
                  <GitPullRequest size={14} />
                  Linked PRs
                </div>
              </th>
              <th className="text-center px-6 py-4 text-sm font-medium text-gray-400">
                <div className="flex items-center justify-center gap-2">
                  <MessageSquare size={14} />
                  Engaged
                </div>
              </th>
              <th className="text-center px-6 py-4 text-sm font-medium text-gray-400">
                <div className="flex items-center justify-center gap-2">
                  <CircleDot size={14} />
                  Open
                </div>
              </th>
              <th className="text-center px-6 py-4 text-sm font-medium text-gray-400">
                <div className="flex items-center justify-center gap-2">
                  <AlertTriangle size={14} />
                  Stalled
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {sortedStats.map((member, index) => (
              <tr
                key={member.username}
                className={`hover:bg-gray-800/50 transition-colors cursor-pointer ${
                  selectedMember === member.username ? 'bg-gray-800' : ''
                }`}
                onClick={() => handleMemberClick(member.username)}
              >
                <td className="px-6 py-4">
                  <span
                    className={`text-lg font-bold ${
                      index === 0
                        ? 'text-yellow-400'
                        : index === 1
                        ? 'text-gray-300'
                        : index === 2
                        ? 'text-amber-600'
                        : 'text-gray-500'
                    }`}
                  >
                    #{index + 1}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center">
                      <User size={16} className="text-gray-400" />
                    </div>
                    <span className="text-white font-medium">@{member.username}</span>
                  </div>
                </td>
                <td className="px-6 py-4 text-center">
                  <span className={`text-lg font-semibold ${getStatColor(member.comments, 'good')}`}>
                    {member.comments}
                  </span>
                </td>
                <td className="px-6 py-4 text-center">
                  <span className={`text-lg font-semibold ${getStatColor(member.issuesClosed, 'good')}`}>
                    {member.issuesClosed}
                  </span>
                </td>
                <td className="px-6 py-4 text-center">
                  <span className={`text-lg font-semibold ${getStatColor(member.linkedPRsCount, 'good')}`}>
                    {member.linkedPRsCount}
                  </span>
                </td>
                <td className="px-6 py-4 text-center">
                  <span className={`text-lg font-semibold ${getStatColor(member.engagedIssuesCount, 'good')}`}>
                    {member.engagedIssuesCount}
                  </span>
                </td>
                <td className="px-6 py-4 text-center">
                  <span className={`text-lg font-semibold ${getStatColor(member.openIssuesCount, 'good')}`}>
                    {member.openIssuesCount}
                  </span>
                </td>
                <td className="px-6 py-4 text-center">
                  <span className={`text-lg font-semibold ${getStatColor(member.stalledIssuesCount, 'warning')}`}>
                    {member.stalledIssuesCount}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Member Detail Panel */}
      {selectedMember && (
        <div className="bg-gray-900 rounded-lg border border-gray-800">
          {/* Tabs */}
          <div className="flex border-b border-gray-800">
            <button
              onClick={() => setDetailTab('stalled')}
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors ${
                detailTab === 'stalled'
                  ? 'text-white border-b-2 border-amber-500 bg-gray-800'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              <AlertTriangle size={16} />
              Stalled ({memberStalledIssues.get(selectedMember)?.length || 0})
            </button>
            <button
              onClick={() => setDetailTab('engaged')}
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors ${
                detailTab === 'engaged'
                  ? 'text-white border-b-2 border-indigo-500 bg-gray-800'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              <MessageSquare size={16} />
              Engaged ({engagedIssues.length})
            </button>
            <button
              onClick={() => setDetailTab('prs')}
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors ${
                detailTab === 'prs'
                  ? 'text-white border-b-2 border-purple-500 bg-gray-800'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              <GitPullRequest size={16} />
              Linked PRs ({memberLinkedPRsCount})
            </button>
            <button
              onClick={() => setDetailTab('expertise')}
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors ${
                detailTab === 'expertise'
                  ? 'text-white border-b-2 border-green-500 bg-gray-800'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              <Target size={16} />
              AoR Expertise
            </button>
          </div>

          {/* Tab Content */}
          {detailTab === 'stalled' && (
            <>
              {(memberStalledIssues.get(selectedMember)?.length || 0) > 0 ? (
                <div className="divide-y divide-gray-800">
                  {memberStalledIssues.get(selectedMember)?.map((issue) => (
                    <IssueRow key={issue.id} issue={issue} status={issueStatusMap.get(issue.id)} />
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center">
                  <CheckCircle className="mx-auto mb-2 text-green-400" size={32} />
                  <p className="text-gray-400">@{selectedMember} has no stalled issues. Great work!</p>
                </div>
              )}
            </>
          )}

          {detailTab === 'engaged' && (
            <>
              {loadingEngaged ? (
                <div className="p-8 text-center text-gray-500">Loading...</div>
              ) : engagedIssues.length > 0 ? (
                <div className="divide-y divide-gray-800 max-h-96 overflow-y-auto">
                  {engagedIssues.map((issue) => (
                    <IssueRow key={issue.id} issue={issue} status={issueStatusMap.get(issue.id)} />
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-gray-500">
                  No issues found for @{selectedMember}
                </div>
              )}
            </>
          )}

          {detailTab === 'prs' && (
            <>
              {loadingEngaged ? (
                <div className="p-8 text-center text-gray-500">Loading...</div>
              ) : issuesWithMemberPRs.length > 0 ? (
                <div className="divide-y divide-gray-800 max-h-96 overflow-y-auto">
                  {issuesWithMemberPRs.map((issue) => (
                    <IssueRow key={issue.id} issue={issue} status={issueStatusMap.get(issue.id)} showPRs selectedMember={selectedMember} />
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-gray-500">
                  No issues with PRs from @{selectedMember}
                </div>
              )}
            </>
          )}

          {detailTab === 'expertise' && (
            <>
              {loadingEngaged ? (
                <div className="p-8 text-center text-gray-500">Loading...</div>
              ) : aorExpertise.length > 0 ? (
                <div className="p-4 space-y-3">
                  <p className="text-sm text-gray-400 mb-4">
                    Areas of Responsibility matched by issue titles @{selectedMember} has engaged with:
                  </p>
                  {aorExpertise.map(({ aor, count, issues }) => (
                    <div
                      key={aor.id}
                      className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden"
                    >
                      <button
                        onClick={() => setExpandedAor(expandedAor === aor.id ? null : aor.id)}
                        className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-700/50 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <Target size={16} className={count > 0 ? 'text-green-400' : 'text-gray-500'} />
                          <span className="text-white font-medium">{aor.name}</span>
                          <div className="flex gap-1">
                            {aor.terms.slice(0, 3).map((term, idx) => (
                              <span key={idx} className="px-1.5 py-0.5 bg-gray-700 rounded text-xs text-gray-400">
                                {term}
                              </span>
                            ))}
                            {aor.terms.length > 3 && (
                              <span className="text-xs text-gray-500">+{aor.terms.length - 3}</span>
                            )}
                          </div>
                        </div>
                        <span className={`text-xl font-bold ${count > 0 ? 'text-green-400' : 'text-gray-500'}`}>
                          {count}
                        </span>
                      </button>
                      
                      {expandedAor === aor.id && issues.length > 0 && (
                        <div className="border-t border-gray-700 divide-y divide-gray-700 max-h-64 overflow-y-auto">
                          {issues.map(issue => (
                            <IssueRow key={issue.id} issue={issue} status={issueStatusMap.get(issue.id)} />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-gray-500">
                  <Target className="mx-auto mb-2 text-gray-600" size={32} />
                  <p>No Areas of Responsibility configured.</p>
                  <p className="text-sm mt-1">Add AoRs in Settings to track expertise.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface IssueRowProps {
  issue: Issue;
  status?: IssueStatus;
  showPRs?: boolean;
  selectedMember?: string;
}

function IssueRow({ issue, status, showPRs, selectedMember }: IssueRowProps) {
  const memberPRs = showPRs && selectedMember 
    ? issue.linkedPRs.filter(pr => pr.author === selectedMember)
    : [];

  return (
    <div className="p-4 hover:bg-gray-800/50 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
              issue.state === 'OPEN' 
                ? 'bg-green-900/50 text-green-400' 
                : 'bg-purple-900/50 text-purple-400'
            }`}>
              {issue.state}
            </span>
            <span className="text-gray-500 text-sm">#{issue.number}</span>
            <span className="text-gray-600">•</span>
            <span className="text-gray-500 text-sm">{issue.repository}</span>
            <a
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-indigo-400 transition-colors ml-1"
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
          <h4 className="text-white font-medium truncate">{issue.title}</h4>
          {showPRs && memberPRs.length > 0 && (
            <div className="mt-2 space-y-1">
              {memberPRs.map(pr => (
                <div key={pr.id} className="flex items-center gap-2 text-sm">
                  <GitPullRequest size={12} className={pr.state === 'MERGED' ? 'text-purple-400' : pr.state === 'OPEN' ? 'text-green-400' : 'text-red-400'} />
                  <span className={`px-1.5 py-0.5 rounded text-xs ${
                    pr.state === 'MERGED' ? 'bg-purple-900/50 text-purple-400' :
                    pr.state === 'OPEN' ? 'bg-green-900/50 text-green-400' :
                    'bg-red-900/50 text-red-400'
                  }`}>
                    {pr.state}
                  </span>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-300 hover:text-indigo-400 transition-colors truncate"
                  >
                    #{pr.number} {pr.title} | @{pr.author}
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default TeamView;
