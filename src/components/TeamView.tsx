import { useState, useEffect } from 'react';
import { MessageSquare, CheckCircle, GitPullRequest, AlertTriangle, ExternalLink, User, Clock, Target, HelpCircle, CircleDot, Activity, Calendar, ChevronDown, ChevronRight } from 'lucide-react';
import { db, getTeamMemberStats, getMemberEngagedIssues, calculateAorExpertise, getBatchIssueStatus, type Issue, type IssueStatus } from '../db';
import { getSettings, type AreaOfResponsibility } from './Settings';
import { useTeamEngagement, type TeamMemberEngagement } from '../hooks/useEngagementCalculator';

interface TeamMemberStats {
  username: string;
  comments: number;
  issuesClosed: number;
  linkedPRsCount: number;
  engagedIssuesCount: number;
  openIssuesCount: number;
  stalledIssuesCount: number;
  awaitingReplyCount: number;
  // Effort tracking metrics
  totalActiveDays: number;
  commDays: number;
  devDays: number;
}

type DetailTab = 'stalled' | 'engaged' | 'prs' | 'expertise' | 'effort';

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
  const [sortBy, setSortBy] = useState<'comments' | 'issuesClosed' | 'linkedPRsCount' | 'engagedIssuesCount' | 'openIssuesCount' | 'stalledIssuesCount' | 'totalActiveDays'>('totalActiveDays');
  const [lookbackDays, setLookbackDays] = useState(180);

  // Get settings for team engagement
  const settings = getSettings();
  const teamMembers = settings.teamMembers;
  const aors = settings.aors;
  
  // Use the engagement calculator hook
  const teamEngagement = useTeamEngagement(teamMembers, aors);

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
      setDetailTab('effort'); // Default to effort tab when selecting new member
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

      // Combine into stats array (engagement metrics will be added from hook)
      const combinedStats: TeamMemberStats[] = teamMembers.map((username) => {
        const memberData = memberStats.get(username) || { comments: 0, issuesClosed: 0, linkedPRsCount: 0 };
        return {
          username,
          ...memberData,
          engagedIssuesCount: memberEngagedIssues.get(username) || 0,
          openIssuesCount: memberOpenIssues.get(username) || 0,
          stalledIssuesCount: memberStalled.get(username)?.length || 0,
          awaitingReplyCount: memberAwaiting.get(username) || 0,
          // Initialize with 0, will be updated from teamEngagement hook
          totalActiveDays: 0,
          commDays: 0,
          devDays: 0,
        };
      });

      setStats(combinedStats);
    } catch (error) {
      console.error('Failed to load team stats:', error);
    } finally {
      setLoading(false);
    }
  };

  // Merge engagement data from hook with stats
  const statsWithEngagement = stats.map(member => {
    const engagement = teamEngagement.get(member.username);
    return {
      ...member,
      totalActiveDays: engagement?.totalActiveDays || 0,
      commDays: engagement?.commDays || 0,
      devDays: engagement?.devDays || 0,
    };
  });

  const sortedStats = [...statsWithEngagement].sort((a, b) => b[sortBy] - a[sortBy]);

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
        <div className="flex gap-2 flex-wrap">
          {[
            { key: 'totalActiveDays', label: 'Active Days', icon: Calendar },
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
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left px-4 py-4 text-sm font-medium text-gray-400">Rank</th>
              <th className="text-left px-4 py-4 text-sm font-medium text-gray-400">Team Member</th>
              <th className="text-center px-4 py-4 text-sm font-medium text-gray-400">
                <div className="flex items-center justify-center gap-2">
                  <Calendar size={14} />
                  Active Days
                </div>
              </th>
              <th className="text-center px-4 py-4 text-sm font-medium text-gray-400 min-w-[160px]">
                <div className="flex items-center justify-center gap-2">
                  <Activity size={14} />
                  Work Split
                </div>
              </th>
              <th className="text-center px-4 py-4 text-sm font-medium text-gray-400">
                <div className="flex items-center justify-center gap-2">
                  <MessageSquare size={14} />
                  Comments
                </div>
              </th>
              <th className="text-center px-4 py-4 text-sm font-medium text-gray-400">
                <div className="flex items-center justify-center gap-2">
                  <CheckCircle size={14} />
                  Closer
                </div>
              </th>
              <th className="text-center px-4 py-4 text-sm font-medium text-gray-400">
                <div className="flex items-center justify-center gap-2">
                  <CircleDot size={14} />
                  Open
                </div>
              </th>
              <th className="text-center px-4 py-4 text-sm font-medium text-gray-400">
                <div className="flex items-center justify-center gap-2">
                  <AlertTriangle size={14} />
                  Stalled
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {sortedStats.map((member, index) => {
              const totalDays = member.commDays + member.devDays;
              const commPercent = totalDays > 0 ? (member.commDays / totalDays) * 100 : 50;
              
              return (
                <tr
                  key={member.username}
                  className={`hover:bg-gray-800/50 transition-colors cursor-pointer ${
                    selectedMember === member.username ? 'bg-gray-800' : ''
                  }`}
                  onClick={() => handleMemberClick(member.username)}
                >
                  <td className="px-4 py-4">
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
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center">
                        <User size={16} className="text-gray-400" />
                      </div>
                      <span className="text-white font-medium">@{member.username}</span>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <span className={`text-lg font-semibold ${getStatColor(member.totalActiveDays, 'good')}`}>
                      {member.totalActiveDays}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    {/* Work Type Split Progress Bar */}
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between text-xs text-gray-500">
                        <span>{member.commDays}d Comm</span>
                        <span>{member.devDays}d Dev</span>
                      </div>
                      <div className="h-2 bg-gray-700 rounded-full overflow-hidden flex">
                        <div
                          className="bg-blue-500 h-full transition-all"
                          style={{ width: `${commPercent}%` }}
                          title={`Communication: ${member.commDays} days`}
                        />
                        <div
                          className="bg-green-500 h-full transition-all"
                          style={{ width: `${100 - commPercent}%` }}
                          title={`Development: ${member.devDays} days`}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <span className={`text-lg font-semibold ${getStatColor(member.comments, 'good')}`}>
                      {member.comments}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <span className={`text-lg font-semibold ${getStatColor(member.issuesClosed, 'good')}`}>
                      {member.issuesClosed}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <span className={`text-lg font-semibold ${getStatColor(member.openIssuesCount, 'good')}`}>
                      {member.openIssuesCount}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <span className={`text-lg font-semibold ${getStatColor(member.stalledIssuesCount, 'warning')}`}>
                      {member.stalledIssuesCount}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Member Detail Panel */}
      {selectedMember && (
        <div className="bg-gray-900 rounded-lg border border-gray-800">
          {/* Tabs */}
          <div className="flex border-b border-gray-800 overflow-x-auto">
            <button
              onClick={() => setDetailTab('effort')}
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors whitespace-nowrap ${
                detailTab === 'effort'
                  ? 'text-white border-b-2 border-cyan-500 bg-gray-800'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              <Activity size={16} />
              Effort Summary
            </button>
            <button
              onClick={() => setDetailTab('stalled')}
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors whitespace-nowrap ${
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
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors whitespace-nowrap ${
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
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors whitespace-nowrap ${
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
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors whitespace-nowrap ${
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
          {detailTab === 'effort' && (
            <EffortSummaryTab 
              member={selectedMember} 
              engagement={teamEngagement.get(selectedMember)} 
            />
          )}

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

// Effort Summary Tab Component
interface EffortSummaryTabProps {
  member: string;
  engagement: TeamMemberEngagement | undefined;
}

function EffortSummaryTab({ engagement }: EffortSummaryTabProps) {
  const [issueDetails, setIssueDetails] = useState<Map<number, Issue>>(new Map());
  const [expandedIssue, setExpandedIssue] = useState<number | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(true);

  // Fetch issue details for the engagement data
  useEffect(() => {
    if (!engagement) return;
    
    const issueIds = Array.from(engagement.issueEngagements.keys());
    if (issueIds.length === 0) {
      setLoadingIssues(false);
      return;
    }

    db.issues.where('id').anyOf(issueIds).toArray()
      .then(issues => {
        const detailsMap = new Map(issues.map(i => [i.id, i]));
        setIssueDetails(detailsMap);
        setLoadingIssues(false);
      })
      .catch(err => {
        console.error('Failed to fetch issue details:', err);
        setLoadingIssues(false);
      });
  }, [engagement]);

  if (!engagement) {
    return (
      <div className="p-8 text-center text-gray-500">
        Loading effort data...
      </div>
    );
  }

  const totalDays = engagement.commDays + engagement.devDays;
  const commPercent = totalDays > 0 ? (engagement.commDays / totalDays) * 100 : 50;

  // Sort issues by total activity (commDays + devDays) descending
  const sortedIssueEngagements = Array.from(engagement.issueEngagements.entries())
    .sort((a, b) => (b[1].commDays + b[1].devDays) - (a[1].commDays + a[1].devDays));

  return (
    <div className="p-6 space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <div className="flex items-center gap-2 text-gray-400 mb-2">
            <Calendar size={16} />
            <span className="text-sm">Total Active Days</span>
          </div>
          <div className="text-3xl font-bold text-cyan-400">
            {engagement.totalActiveDays}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Unique days with any activity
          </div>
        </div>

        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <div className="flex items-center gap-2 text-gray-400 mb-2">
            <MessageSquare size={16} />
            <span className="text-sm">Communication Days</span>
          </div>
          <div className="text-3xl font-bold text-blue-400">
            {engagement.commDays}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Days with issue comments
          </div>
        </div>

        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <div className="flex items-center gap-2 text-gray-400 mb-2">
            <GitPullRequest size={16} />
            <span className="text-sm">Development Days</span>
          </div>
          <div className="text-3xl font-bold text-green-400">
            {engagement.devDays}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Days with PR activity
          </div>
        </div>
      </div>

      {/* Work Type Split */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h4 className="text-white font-medium mb-3">Work Type Distribution</h4>
        <div className="mb-2">
          <div className="flex justify-between text-sm text-gray-400 mb-1">
            <span className="flex items-center gap-2">
              <div className="w-3 h-3 bg-blue-500 rounded" />
              Communication ({engagement.commDays} days)
            </span>
            <span className="flex items-center gap-2">
              Development ({engagement.devDays} days)
              <div className="w-3 h-3 bg-green-500 rounded" />
            </span>
          </div>
          <div className="h-4 bg-gray-700 rounded-full overflow-hidden flex">
            <div
              className="bg-blue-500 h-full transition-all"
              style={{ width: `${commPercent}%` }}
            />
            <div
              className="bg-green-500 h-full transition-all"
              style={{ width: `${100 - commPercent}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>{Math.round(commPercent)}%</span>
            <span>{Math.round(100 - commPercent)}%</span>
          </div>
        </div>
      </div>

      {/* Issue-Level Breakdown */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h4 className="text-white font-medium mb-3">Issue-Level Activity Breakdown</h4>
        {loadingIssues ? (
          <div className="text-gray-500 text-center py-4">Loading issue details...</div>
        ) : sortedIssueEngagements.length === 0 ? (
          <div className="text-gray-500 text-center py-4">No issue activity found</div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {sortedIssueEngagements.map(([issueId, issueEngagement]) => {
              const issue = issueDetails.get(issueId);
              const isExpanded = expandedIssue === issueId;
              
              return (
                <div key={issueId} className="bg-gray-700/50 rounded-lg border border-gray-600 overflow-hidden">
                  {/* Issue Header */}
                  <button
                    onClick={() => setExpandedIssue(isExpanded ? null : issueId)}
                    className="w-full px-3 py-2 flex items-center gap-3 hover:bg-gray-700 transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronDown size={16} className="text-gray-400 flex-shrink-0" />
                    ) : (
                      <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0 text-left">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-gray-400 text-xs">#{issue?.number || issueId}</span>
                        <span className="text-gray-600 text-xs">•</span>
                        <span className="text-gray-500 text-xs truncate">{issue?.repository || 'Unknown'}</span>
                        {issue && (
                          <a
                            href={issue.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-gray-500 hover:text-indigo-400 transition-colors"
                          >
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                      <div className="text-white text-sm truncate">
                        {issue?.title || `Issue #${issueId}`}
                      </div>
                    </div>
                    {/* Summary badges */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="px-2 py-0.5 rounded text-xs bg-blue-900/50 text-blue-400 border border-blue-800">
                        {issueEngagement.commDays}d / {issueEngagement.totalComments}c
                      </span>
                      <span className="px-2 py-0.5 rounded text-xs bg-green-900/50 text-green-400 border border-green-800">
                        {issueEngagement.devDays}d / {issueEngagement.totalPRActivities}pr
                      </span>
                    </div>
                  </button>
                  
                  {/* Expanded: Date-level breakdown */}
                  {isExpanded && issueEngagement.activityDetails.length > 0 && (
                    <div className="border-t border-gray-600 px-3 py-2 bg-gray-800/50">
                      <div className="text-xs text-gray-400 mb-2 flex items-center gap-4">
                        <span>Date</span>
                        <span className="flex items-center gap-1">
                          <div className="w-2 h-2 bg-blue-500 rounded" /> Comments
                        </span>
                        <span className="flex items-center gap-1">
                          <div className="w-2 h-2 bg-green-500 rounded" /> PR Activities
                        </span>
                      </div>
                      <div className="space-y-1">
                        {issueEngagement.activityDetails.map(detail => (
                          <div
                            key={detail.date}
                            className="flex items-center gap-4 text-sm py-1 px-2 rounded hover:bg-gray-700/50"
                          >
                            <span className="text-gray-300 font-mono text-xs w-24">
                              {detail.date}
                            </span>
                            <div className="flex items-center gap-1 w-20">
                              <MessageSquare size={12} className="text-blue-400" />
                              <span className={detail.commentCount > 0 ? 'text-blue-400' : 'text-gray-600'}>
                                {detail.commentCount}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 w-20">
                              <GitPullRequest size={12} className="text-green-400" />
                              <span className={detail.prActivityCount > 0 ? 'text-green-400' : 'text-gray-600'}>
                                {detail.prActivityCount}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Top AoRs */}
      {engagement.topAors.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <h4 className="text-white font-medium mb-3">Top Areas of Responsibility</h4>
          <div className="space-y-2">
            {engagement.topAors.map((aor, index) => (
              <div key={aor.aorId} className="flex items-center gap-3">
                <span className={`text-lg font-bold ${
                  index === 0 ? 'text-yellow-400' :
                  index === 1 ? 'text-gray-300' :
                  'text-amber-600'
                }`}>
                  #{index + 1}
                </span>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="text-white">{aor.aorName}</span>
                    <span className="text-purple-400 font-semibold">{aor.activityDays} days</span>
                  </div>
                  <div className="h-1.5 bg-gray-700 rounded-full mt-1 overflow-hidden">
                    <div
                      className="h-full bg-purple-500 rounded-full"
                      style={{ 
                        width: `${engagement.topAors[0].activityDays > 0 
                          ? (aor.activityDays / engagement.topAors[0].activityDays) * 100 
                          : 0}%` 
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Context Switch Info */}
      <div className="text-xs text-gray-500 p-3 bg-gray-800/50 rounded-lg border border-gray-700/50">
        <strong>Context Switch Factor:</strong> When a team member works on multiple issues in a single day, 
        each issue receives a fractional "Day Credit" (1/N where N = number of issues that day) to reflect 
        fragmented focus. This helps identify both breadth of coverage and depth of engagement.
      </div>
    </div>
  );
}

export default TeamView;
