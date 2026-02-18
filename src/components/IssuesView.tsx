import { useState, useMemo, useCallback } from 'react';
import { MessageSquare, GitPullRequest, CheckCircle, ExternalLink, Users, Calendar, Activity, ArrowUpDown, Filter, CircleDot, FileText, User, ChevronDown, ChevronRight, FileEdit, Send, X, Loader2 } from 'lucide-react';
import { getSettings } from './Settings';
import { useAllIssuesTeamEffort, useIssueMemberBreakdown, type IssueTeamEffort, type MemberIssueContribution } from '../hooks/useEngagementCalculator';
import { fetchDiscussionCategories, createDiscussion, type DiscussionCategory } from '../api/github';
import { db } from '../db';

type SortKey = 'totalEffortDays' | 'commenterDays' | 'authorDays' | 'reviewerDays' | 'contributors' | 'updatedAt';
type StateFilter = 'all' | 'open' | 'closed';

// ============================================================================
// Report Generation
// ============================================================================

interface IssueMemberData {
  issueId: number;
  issueNumber: number;
  repository: string;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  totalEffortDays: number;
  commenterDays: number;
  authorDays: number;
  reviewerDays: number;
  memberBreakdown: MemberIssueContribution[];
}

function generateReportMarkdown(
  issues: IssueTeamEffort[],
  issueMemberData: IssueMemberData[],
  summary: {
    openCount: number;
    closedCount: number;
    totalCommenterDays: number;
    totalAuthorDays: number;
    totalReviewerDays: number;
    totalEffort: number;
  },
  lookbackDays: number,
  repositories: string[]
): string {
  const lines: string[] = [];
  const repoList = repositories.length ? repositories.join(', ') : 'configured repositories';
  
  // Header
  lines.push(`Report generated on ${new Date().toLocaleDateString()} for ${repoList} (last ${lookbackDays} days).`);
  lines.push('');
  
  // Summary Section
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Issues Tracked | ${issues.length} (${summary.openCount} open, ${summary.closedCount} closed) |`);
  lines.push(`| Total Effort | **${summary.totalEffort}** member-days |`);
  lines.push(`| Commenter Days | ${summary.totalCommenterDays} |`);
  lines.push(`| Author Days | ${summary.totalAuthorDays} |`);
  lines.push(`| Reviewer Days | ${summary.totalReviewerDays} |`);
  if (issues.length > 0) {
    lines.push(`| Average per Issue | ${(summary.totalEffort / issues.length).toFixed(1)} member-days |`);
  }
  lines.push('');
  
  // Issues Table
  lines.push('## Issues by Effort');
  lines.push('');
  lines.push('| Issue | State | Total | Comm | Author | Review | Contributors |');
  lines.push('|-------|-------|-------|------|--------|--------|--------------|');
  
  for (const issue of issues) {
    const state = issue.state === 'OPEN' ? '🟢 Open' : '🟣 Closed';
    const issueLink = `[#${issue.issueNumber}](${issue.url})`;
    const title = issue.title.length > 50 ? issue.title.slice(0, 47) + '...' : issue.title;
    const contributors = issue.contributors.map(c => `@${c}`).join(', ');
    lines.push(`| ${issueLink} ${title} | ${state} | **${issue.totalEffortDays}** | ${issue.commenterDays} | ${issue.authorDays} | ${issue.reviewerDays} | ${contributors} |`);
  }
  lines.push('');
  
  // Detailed breakdown per issue
  lines.push('## Detailed Issue Breakdown');
  lines.push('');
  
  for (const issueData of issueMemberData) {
    const state = issueData.state === 'OPEN' ? '🟢 Open' : '🟣 Closed';
    lines.push(`### [#${issueData.issueNumber}](${issueData.url}) ${issueData.title}`);
    lines.push('');
    lines.push(`**Repository:** ${issueData.repository} | **State:** ${state}`);
    lines.push('');
    lines.push(`**Effort:** ${issueData.totalEffortDays} member-days (Comm: ${issueData.commenterDays}, Author: ${issueData.authorDays}, Review: ${issueData.reviewerDays})`);
    lines.push('');
    
    if (issueData.memberBreakdown.length > 0) {
      lines.push('**Team Activity:**');
      lines.push('');
      
      for (const member of issueData.memberBreakdown) {
        lines.push(`#### @${member.username} — ${member.totalDays}d (C: ${member.commenterDays}, A: ${member.authorDays}, R: ${member.reviewerDays})`);
        lines.push('');
        
        // Comments
        if (member.commentActivity.length > 0) {
          lines.push('- **Comments:**');
          for (const activity of member.commentActivity) {
            if (activity.commentUrl) {
              lines.push(`  - ${activity.date} ([link](${activity.commentUrl}))`);
            } else {
              lines.push(`  - ${activity.date}`);
            }
          }
        }
        
        // Authoring
        if (member.authorActivity.length > 0) {
          lines.push('- **Authoring:**');
          for (const activity of member.authorActivity) {
            const prLinks = activity.prLinks.map(pr => `[#${pr.number}](${pr.url})`).join(', ');
            lines.push(`  - ${activity.date}: ${prLinks}`);
          }
        }
        
        // Reviewing
        if (member.reviewerActivity.length > 0) {
          lines.push('- **Reviewing:**');
          for (const activity of member.reviewerActivity) {
            const prLinks = activity.prLinks.map(pr => `[#${pr.number}](${pr.url})`).join(', ');
            lines.push(`  - ${activity.date}: ${prLinks}`);
          }
        }
        
        lines.push('');
      }
    }
    
    lines.push('---');
    lines.push('');
  }
  
  return lines.join('\n');
}

export function IssuesView() {
  const [sortBy, setSortBy] = useState<SortKey>('totalEffortDays');
  const [sortAsc, setSortAsc] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(null);
  
  // Report editor state
  const [showReportEditor, setShowReportEditor] = useState(false);
  const [reportTitle, setReportTitle] = useState('');
  const [reportBody, setReportBody] = useState('');
  const [reportRepo, setReportRepo] = useState<string>('');
  const [reportCategories, setReportCategories] = useState<DiscussionCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<{ url: string; number: number } | null>(null);

  // Get settings
  const settings = getSettings();
  const teamMembers = settings.teamMembers;
  const lookbackDays = settings.lookbackDays;

  // Get all issues with team effort
  const allIssues = useAllIssuesTeamEffort(teamMembers);

  // Get unique repositories for filter dropdown
  const repositories = useMemo(() => {
    const repos = new Set(allIssues.map(i => i.repository));
    return Array.from(repos).sort();
  }, [allIssues]);

  // Filter and sort issues
  const filteredIssues = useMemo(() => {
    let filtered = allIssues;

    // State filter
    if (stateFilter === 'open') {
      filtered = filtered.filter(i => i.state === 'OPEN');
    } else if (stateFilter === 'closed') {
      filtered = filtered.filter(i => i.state === 'CLOSED');
    }

    // Repository filter
    if (repoFilter !== 'all') {
      filtered = filtered.filter(i => i.repository === repoFilter);
    }

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(i => 
        i.title.toLowerCase().includes(query) ||
        i.issueNumber.toString().includes(query) ||
        i.repository.toLowerCase().includes(query)
      );
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      let comparison = 0;
      switch (sortBy) {
        case 'totalEffortDays':
          comparison = a.totalEffortDays - b.totalEffortDays;
          break;
        case 'commenterDays':
          comparison = a.commenterDays - b.commenterDays;
          break;
        case 'authorDays':
          comparison = a.authorDays - b.authorDays;
          break;
        case 'reviewerDays':
          comparison = a.reviewerDays - b.reviewerDays;
          break;
        case 'contributors':
          comparison = a.contributors.length - b.contributors.length;
          break;
        case 'updatedAt':
          comparison = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          break;
      }
      return sortAsc ? comparison : -comparison;
    });

    return sorted;
  }, [allIssues, stateFilter, repoFilter, searchQuery, sortBy, sortAsc]);

  // Summary stats
  const summary = useMemo(() => {
    const openCount = filteredIssues.filter(i => i.state === 'OPEN').length;
    const closedCount = filteredIssues.filter(i => i.state === 'CLOSED').length;
    const totalCommenterDays = filteredIssues.reduce((sum, i) => sum + i.commenterDays, 0);
    const totalAuthorDays = filteredIssues.reduce((sum, i) => sum + i.authorDays, 0);
    const totalReviewerDays = filteredIssues.reduce((sum, i) => sum + i.reviewerDays, 0);
    const totalEffort = totalCommenterDays + totalAuthorDays + totalReviewerDays;
    return { openCount, closedCount, totalCommenterDays, totalAuthorDays, totalReviewerDays, totalEffort };
  }, [filteredIssues]);

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(key);
      setSortAsc(false);
    }
  };

  const handleIssueClick = (issueId: number) => {
    setSelectedIssueId(selectedIssueId === issueId ? null : issueId);
  };

  // Generate report handler
  const handleGenerateReport = useCallback(async () => {
    // Fetch member breakdown for each issue (this is async since we need individual queries)
    const issueMemberData: IssueMemberData[] = [];
    
    for (const issue of filteredIssues) {
      // Get comments and PR activities for this issue from db
      const comments = await db.comments.where('issueId').equals(issue.issueId).toArray();
      const dbIssue = await db.issues.get(issue.issueId);
      
      if (!dbIssue) continue;
      
      const linkedPRIds = new Set(dbIssue.linkedPRs.map(pr => pr.id));
      const prActivities = await db.prActivity.filter(a => linkedPRIds.has(a.prId)).toArray();
      
      // Build PR author map
      const prAuthorMap = new Map<number, string>();
      const prInfoMap = new Map<number, { number: number; url: string }>();
      for (const pr of dbIssue.linkedPRs) {
        prAuthorMap.set(pr.id, pr.author);
        prInfoMap.set(pr.id, { number: pr.number, url: pr.url });
      }
      
      // Calculate per-member breakdown in-place (simplified version matching useIssueMemberBreakdown)
      const teamMemberSet = new Set(teamMembers);
      const memberContributions = new Map<string, MemberIssueContribution>();
      
      // Process comments
      for (const comment of comments) {
        if (!teamMemberSet.has(comment.author)) continue;
        if (!memberContributions.has(comment.author)) {
          memberContributions.set(comment.author, {
            username: comment.author,
            commenterDays: 0,
            authorDays: 0,
            reviewerDays: 0,
            totalDays: 0,
            commentActivity: [],
            authorActivity: [],
            reviewerActivity: [],
          });
        }
        const dateKey = new Date(comment.createdAt).toISOString().split('T')[0];
        const mc = memberContributions.get(comment.author)!;
        const existingDateIdx = mc.commentActivity.findIndex(a => a.date === dateKey);
        if (existingDateIdx === -1) {
          mc.commentActivity.push({
            date: dateKey,
            commentUrl: `${issue.url}#issuecomment-${comment.id}`,
            prLinks: [],
          });
        }
      }
      
      // Process PR activities
      for (const activity of prActivities) {
        if (!teamMemberSet.has(activity.author)) continue;
        if (!memberContributions.has(activity.author)) {
          memberContributions.set(activity.author, {
            username: activity.author,
            commenterDays: 0,
            authorDays: 0,
            reviewerDays: 0,
            totalDays: 0,
            commentActivity: [],
            authorActivity: [],
            reviewerActivity: [],
          });
        }
        
        const dateKey = new Date(activity.createdAt).toISOString().split('T')[0];
        const prAuthor = prAuthorMap.get(activity.prId);
        const prInfo = prInfoMap.get(activity.prId);
        const mc = memberContributions.get(activity.author)!;
        
        if (activity.type === 'commit' && prAuthor === activity.author && prInfo) {
          // Author activity
          const existingDateIdx = mc.authorActivity.findIndex(a => a.date === dateKey);
          if (existingDateIdx === -1) {
            mc.authorActivity.push({ date: dateKey, prLinks: [prInfo] });
          } else {
            const existing = mc.authorActivity[existingDateIdx];
            if (!existing.prLinks.find(p => p.number === prInfo.number)) {
              existing.prLinks.push(prInfo);
            }
          }
        } else if ((activity.type === 'review' || activity.type === 'review_comment') && prAuthor !== activity.author && prInfo) {
          // Reviewer activity
          const existingDateIdx = mc.reviewerActivity.findIndex(a => a.date === dateKey);
          if (existingDateIdx === -1) {
            mc.reviewerActivity.push({ date: dateKey, prLinks: [prInfo] });
          } else {
            const existing = mc.reviewerActivity[existingDateIdx];
            if (!existing.prLinks.find(p => p.number === prInfo.number)) {
              existing.prLinks.push(prInfo);
            }
          }
        }
      }
      
      // Calculate day counts
      const memberBreakdown: MemberIssueContribution[] = [];
      for (const mc of memberContributions.values()) {
        mc.commenterDays = mc.commentActivity.length;
        mc.authorDays = mc.authorActivity.length;
        mc.reviewerDays = mc.reviewerActivity.length;
        mc.totalDays = mc.commenterDays + mc.authorDays + mc.reviewerDays;
        
        // Sort activities
        mc.commentActivity.sort((a, b) => b.date.localeCompare(a.date));
        mc.authorActivity.sort((a, b) => b.date.localeCompare(a.date));
        mc.reviewerActivity.sort((a, b) => b.date.localeCompare(a.date));
        
        if (mc.totalDays > 0) {
          memberBreakdown.push(mc);
        }
      }
      
      // Sort by total days
      memberBreakdown.sort((a, b) => b.totalDays - a.totalDays);
      
      issueMemberData.push({
        issueId: issue.issueId,
        issueNumber: issue.issueNumber,
        repository: issue.repository,
        title: issue.title,
        url: issue.url,
        state: issue.state,
        totalEffortDays: issue.totalEffortDays,
        commenterDays: issue.commenterDays,
        authorDays: issue.authorDays,
        reviewerDays: issue.reviewerDays,
        memberBreakdown,
      });
    }

    // Generate markdown
    const markdown = generateReportMarkdown(
      filteredIssues,
      issueMemberData,
      summary,
      lookbackDays,
      repositories
    );

    // Set default title
    const repoName = repoFilter !== 'all' ? repoFilter : repositories.join(', ');
    setReportTitle(`Team Staffing for ${repoName} (Last ${lookbackDays} Days)`);
    setReportBody(markdown);
    setReportRepo(repoFilter !== 'all' ? repoFilter : (repositories[0] || ''));
    setSubmitError(null);
    setSubmitSuccess(null);
    setShowReportEditor(true);

    // Fetch discussion categories for the first repo
    const targetRepo = repoFilter !== 'all' ? repoFilter : repositories[0];
    if (targetRepo && settings.pat) {
      try {
        const { categories } = await fetchDiscussionCategories(settings.pat, targetRepo);
        setReportCategories(categories);
        // Default to "General" or first category
        const generalCat = categories.find(c => c.slug === 'general' || c.name.toLowerCase() === 'general');
        setSelectedCategoryId(generalCat?.id || categories[0]?.id || '');
      } catch {
        setReportCategories([]);
        setSelectedCategoryId('');
      }
    }
  }, [filteredIssues, summary, lookbackDays, repositories, repoFilter, teamMembers, settings.pat]);

  // Submit report handler
  const handleSubmitReport = useCallback(async () => {
    if (!reportRepo || !selectedCategoryId || !reportTitle.trim() || !reportBody.trim()) {
      setSubmitError('Please fill in all fields and select a category.');
      return;
    }

    const token = settings.pat;
    if (!token) {
      setSubmitError('GitHub token not configured.');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Get repository ID
      const { repositoryId } = await fetchDiscussionCategories(token, reportRepo);
      
      // Create discussion
      const result = await createDiscussion(
        token,
        repositoryId,
        selectedCategoryId,
        reportTitle.trim(),
        reportBody
      );

      setSubmitSuccess(result);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to create discussion');
    } finally {
      setIsSubmitting(false);
    }
  }, [reportRepo, selectedCategoryId, reportTitle, reportBody, settings.pat]);

  // Handle repo change in report editor
  const handleReportRepoChange = useCallback(async (repo: string) => {
    setReportRepo(repo);
    setReportCategories([]);
    setSelectedCategoryId('');

    if (repo && settings.pat) {
      try {
        const { categories } = await fetchDiscussionCategories(settings.pat, repo);
        setReportCategories(categories);
        const generalCat = categories.find(c => c.slug === 'general' || c.name.toLowerCase() === 'general');
        setSelectedCategoryId(generalCat?.id || categories[0]?.id || '');
      } catch {
        setReportCategories([]);
      }
    }
  }, [settings.pat]);

  // Find the selected issue from filtered list
  const selectedIssue = selectedIssueId 
    ? filteredIssues.find(i => i.issueId === selectedIssueId) || allIssues.find(i => i.issueId === selectedIssueId)
    : null;

  if (teamMembers.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">All Issues</h2>
          <p className="text-gray-400">View effort spent on all issues within the lookback period.</p>
        </div>
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-8 text-center">
          <Users className="mx-auto mb-4 text-gray-600" size={48} />
          <p className="text-gray-400">No team members configured.</p>
          <p className="text-gray-500 text-sm mt-2">
            Add team members in Settings to track effort.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">All Issues</h2>
          <p className="text-gray-400">
            Team effort spent on issues over the last {lookbackDays} days.
            Each team member's activity counts separately.
          </p>
        </div>
        <button
          onClick={handleGenerateReport}
          disabled={filteredIssues.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          <FileEdit size={16} />
          Generate Report
        </button>
      </div>

      {/* Report Editor Modal */}
      {showReportEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-4xl max-h-[90vh] flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <h3 className="text-lg font-semibold text-white">Generate Discussion Report</h3>
              <button
                onClick={() => setShowReportEditor(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Success Message */}
              {submitSuccess && (
                <div className="bg-green-900/50 border border-green-700 rounded-lg p-4">
                  <p className="text-green-400 font-medium">Discussion created successfully!</p>
                  <a
                    href={submitSuccess.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-green-300 hover:text-green-200 underline mt-1 inline-block"
                  >
                    View Discussion #{submitSuccess.number} →
                  </a>
                </div>
              )}

              {/* Error Message */}
              {submitError && (
                <div className="bg-red-900/50 border border-red-700 rounded-lg p-4">
                  <p className="text-red-400">{submitError}</p>
                </div>
              )}

              {/* Repository Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Target Repository
                </label>
                <input
                  type="text"
                  value={reportRepo}
                  onChange={(e) => handleReportRepoChange(e.target.value)}
                  placeholder="owner/repo"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* Category Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Discussion Category
                </label>
                <select
                  value={selectedCategoryId}
                  onChange={(e) => setSelectedCategoryId(e.target.value)}
                  disabled={reportCategories.length === 0}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                  {reportCategories.length === 0 ? (
                    <option value="">Select repository first...</option>
                  ) : (
                    reportCategories.map(cat => (
                      <option key={cat.id} value={cat.id}>{cat.name}</option>
                    ))
                  )}
                </select>
              </div>

              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Title
                </label>
                <input
                  type="text"
                  value={reportTitle}
                  onChange={(e) => setReportTitle(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="Enter discussion title..."
                />
              </div>

              {/* Body */}
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Report Content (Markdown)
                </label>
                <textarea
                  value={reportBody}
                  onChange={(e) => setReportBody(e.target.value)}
                  rows={20}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 p-4 border-t border-gray-800">
              <button
                onClick={() => setShowReportEditor(false)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitReport}
                disabled={isSubmitting || !reportRepo || !selectedCategoryId || submitSuccess !== null}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Send size={16} />
                    Submit Discussion
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-6 gap-4">
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="flex items-center gap-2 text-gray-400 mb-1">
            <FileText size={14} />
            <span className="text-xs">Issues</span>
          </div>
          <div className="text-2xl font-bold text-white">{filteredIssues.length}</div>
          <div className="text-xs text-gray-500 mt-1">
            {summary.openCount} open / {summary.closedCount} closed
          </div>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="flex items-center gap-2 text-gray-400 mb-1">
            <Activity size={14} />
            <span className="text-xs">Total Effort</span>
          </div>
          <div className="text-2xl font-bold text-cyan-400">{summary.totalEffort}</div>
          <div className="text-xs text-gray-500 mt-1">member-days</div>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="flex items-center gap-2 text-gray-400 mb-1">
            <MessageSquare size={14} />
            <span className="text-xs">Commenter</span>
          </div>
          <div className="text-2xl font-bold text-blue-400">{summary.totalCommenterDays}</div>
          <div className="text-xs text-gray-500 mt-1">member-days</div>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="flex items-center gap-2 text-gray-400 mb-1">
            <GitPullRequest size={14} />
            <span className="text-xs">Author</span>
          </div>
          <div className="text-2xl font-bold text-green-400">{summary.totalAuthorDays}</div>
          <div className="text-xs text-gray-500 mt-1">member-days</div>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="flex items-center gap-2 text-gray-400 mb-1">
            <CheckCircle size={14} />
            <span className="text-xs">Reviewer</span>
          </div>
          <div className="text-2xl font-bold text-amber-400">{summary.totalReviewerDays}</div>
          <div className="text-xs text-gray-500 mt-1">member-days</div>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="flex items-center gap-2 text-gray-400 mb-1">
            <Calendar size={14} />
            <span className="text-xs">Avg/Issue</span>
          </div>
          <div className="text-2xl font-bold text-purple-400">
            {filteredIssues.length > 0 ? (summary.totalEffort / filteredIssues.length).toFixed(1) : '0'}
          </div>
          <div className="text-xs text-gray-500 mt-1">member-days</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Filter size={16} className="text-gray-400" />
          <span className="text-sm text-gray-400">Filters:</span>
        </div>

        {/* State Filter */}
        <div className="flex gap-1">
          {(['all', 'open', 'closed'] as StateFilter[]).map(state => (
            <button
              key={state}
              onClick={() => setStateFilter(state)}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                stateFilter === state
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {state === 'all' ? 'All States' : state.charAt(0).toUpperCase() + state.slice(1)}
            </button>
          ))}
        </div>

        {/* Repository Filter */}
        <select
          value={repoFilter}
          onChange={(e) => setRepoFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">All Repositories</option>
          {repositories.map(repo => (
            <option key={repo} value={repo}>{repo}</option>
          ))}
        </select>

        {/* Search */}
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search issues..."
          className="flex-1 min-w-48 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {/* Issues Table */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Issue</th>
                <th className="text-center px-4 py-3 text-sm font-medium text-gray-400 w-20">State</th>
                <th className="text-center px-4 py-3 text-sm font-medium text-gray-400 w-24">
                  <button
                    onClick={() => handleSort('totalEffortDays')}
                    className="flex items-center justify-center gap-1 hover:text-white transition-colors mx-auto"
                  >
                    <Activity size={14} />
                    Total
                    {sortBy === 'totalEffortDays' && <ArrowUpDown size={12} className={sortAsc ? 'rotate-180' : ''} />}
                  </button>
                </th>
                <th className="text-center px-4 py-3 text-sm font-medium text-gray-400 w-24">
                  <button
                    onClick={() => handleSort('commenterDays')}
                    className="flex items-center justify-center gap-1 hover:text-white transition-colors mx-auto"
                  >
                    <MessageSquare size={14} />
                    Comm
                    {sortBy === 'commenterDays' && <ArrowUpDown size={12} className={sortAsc ? 'rotate-180' : ''} />}
                  </button>
                </th>
                <th className="text-center px-4 py-3 text-sm font-medium text-gray-400 w-24">
                  <button
                    onClick={() => handleSort('authorDays')}
                    className="flex items-center justify-center gap-1 hover:text-white transition-colors mx-auto"
                  >
                    <GitPullRequest size={14} />
                    Author
                    {sortBy === 'authorDays' && <ArrowUpDown size={12} className={sortAsc ? 'rotate-180' : ''} />}
                  </button>
                </th>
                <th className="text-center px-4 py-3 text-sm font-medium text-gray-400 w-24">
                  <button
                    onClick={() => handleSort('reviewerDays')}
                    className="flex items-center justify-center gap-1 hover:text-white transition-colors mx-auto"
                  >
                    <CheckCircle size={14} />
                    Review
                    {sortBy === 'reviewerDays' && <ArrowUpDown size={12} className={sortAsc ? 'rotate-180' : ''} />}
                  </button>
                </th>
                <th className="text-center px-4 py-3 text-sm font-medium text-gray-400 w-28">
                  <button
                    onClick={() => handleSort('contributors')}
                    className="flex items-center justify-center gap-1 hover:text-white transition-colors mx-auto"
                  >
                    <Users size={14} />
                    Team
                    {sortBy === 'contributors' && <ArrowUpDown size={12} className={sortAsc ? 'rotate-180' : ''} />}
                  </button>
                </th>
                <th className="text-center px-4 py-3 text-sm font-medium text-gray-400 w-32">
                  <button
                    onClick={() => handleSort('updatedAt')}
                    className="flex items-center justify-center gap-1 hover:text-white transition-colors mx-auto"
                  >
                    <Calendar size={14} />
                    Updated
                    {sortBy === 'updatedAt' && <ArrowUpDown size={12} className={sortAsc ? 'rotate-180' : ''} />}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filteredIssues.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    No issues found matching your filters.
                  </td>
                </tr>
              ) : (
                filteredIssues.map((issue) => (
                  <IssueRow 
                    key={issue.issueId} 
                    issue={issue} 
                    isSelected={selectedIssueId === issue.issueId}
                    onClick={() => handleIssueClick(issue.issueId)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Issue Detail Panel */}
      {selectedIssue && (
        <IssueDetailPanel 
          issue={selectedIssue} 
          teamMembers={teamMembers}
        />
      )}
    </div>
  );
}

interface IssueRowProps {
  issue: IssueTeamEffort;
  isSelected: boolean;
  onClick: () => void;
}

function IssueRow({ issue, isSelected, onClick }: IssueRowProps) {
  return (
    <tr 
      className={`hover:bg-gray-800/50 transition-colors cursor-pointer ${
        isSelected ? 'bg-gray-800' : ''
      }`}
      onClick={onClick}
    >
      <td className="px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-gray-400 text-xs">#{issue.issueNumber}</span>
            <span className="text-gray-600 text-xs">•</span>
            <span className="text-gray-500 text-xs truncate">{issue.repository}</span>
            <a
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-gray-500 hover:text-indigo-400 transition-colors"
            >
              <ExternalLink size={12} />
            </a>
          </div>
          <div className="text-white text-sm truncate max-w-md" title={issue.title}>
            {issue.title}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-center">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
          issue.state === 'OPEN' 
            ? 'bg-green-900/50 text-green-400' 
            : 'bg-purple-900/50 text-purple-400'
        }`}>
          <CircleDot size={10} />
          {issue.state}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        <span className="text-lg font-semibold text-cyan-400">{issue.totalEffortDays}</span>
      </td>
      <td className="px-4 py-3 text-center">
        <span className={`text-lg font-semibold ${issue.commenterDays > 0 ? 'text-blue-400' : 'text-gray-600'}`}>
          {issue.commenterDays}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        <span className={`text-lg font-semibold ${issue.authorDays > 0 ? 'text-green-400' : 'text-gray-600'}`}>
          {issue.authorDays}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        <span className={`text-lg font-semibold ${issue.reviewerDays > 0 ? 'text-amber-400' : 'text-gray-600'}`}>
          {issue.reviewerDays}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-center gap-1" title={issue.contributors.join(', ')}>
          <Users size={14} className="text-gray-400" />
          <span className="text-gray-300">{issue.contributors.length}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-center">
        <span className="text-xs text-gray-400">
          {new Date(issue.updatedAt).toLocaleDateString()}
        </span>
      </td>
    </tr>
  );
}

// Issue Detail Panel Component
interface IssueDetailPanelProps {
  issue: IssueTeamEffort;
  teamMembers: string[];
}

function IssueDetailPanel({ issue, teamMembers }: IssueDetailPanelProps) {
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  
  // Get per-member breakdown
  const memberBreakdown = useIssueMemberBreakdown(issue.issueId, teamMembers);

  // Calculate percentages for the distribution bar
  const total = issue.totalEffortDays;
  const commPercent = total > 0 ? (issue.commenterDays / total) * 100 : 33.33;
  const authorPercent = total > 0 ? (issue.authorDays / total) * 100 : 33.33;
  const reviewerPercent = total > 0 ? (issue.reviewerDays / total) * 100 : 33.34;

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      {/* Issue Header */}
      <div className="p-4 border-b border-gray-800 bg-gray-800/50">
        <div className="flex items-center gap-2 mb-1">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
            issue.state === 'OPEN' 
              ? 'bg-green-900/50 text-green-400' 
              : 'bg-purple-900/50 text-purple-400'
          }`}>
            {issue.state}
          </span>
          <span className="text-gray-400 text-sm">#{issue.issueNumber}</span>
          <span className="text-gray-600">•</span>
          <span className="text-gray-500 text-sm">{issue.repository}</span>
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-indigo-400 transition-colors"
          >
            <ExternalLink size={14} />
          </a>
        </div>
        <h3 className="text-lg font-medium text-white">{issue.title}</h3>
      </div>

      <div className="p-6 space-y-6">
        {/* Effort Summary Cards */}
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
            <div className="flex items-center gap-2 text-gray-400 mb-2">
              <Activity size={16} />
              <span className="text-sm">Total Effort</span>
            </div>
            <div className="text-3xl font-bold text-cyan-400">
              {issue.totalEffortDays}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              member-days
            </div>
          </div>

          <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
            <div className="flex items-center gap-2 text-gray-400 mb-2">
              <MessageSquare size={16} />
              <span className="text-sm">Commenter</span>
            </div>
            <div className="text-3xl font-bold text-blue-400">
              {issue.commenterDays}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              member-days
            </div>
          </div>

          <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
            <div className="flex items-center gap-2 text-gray-400 mb-2">
              <GitPullRequest size={16} />
              <span className="text-sm">Author</span>
            </div>
            <div className="text-3xl font-bold text-green-400">
              {issue.authorDays}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              member-days
            </div>
          </div>

          <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
            <div className="flex items-center gap-2 text-gray-400 mb-2">
              <CheckCircle size={16} />
              <span className="text-sm">Reviewer</span>
            </div>
            <div className="text-3xl font-bold text-amber-400">
              {issue.reviewerDays}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              member-days
            </div>
          </div>
        </div>

        {/* Effort Distribution Bar */}
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <h4 className="text-white font-medium mb-3">Effort Distribution</h4>
          <div className="mb-2">
            <div className="flex justify-between text-sm text-gray-400 mb-1">
              <span className="flex items-center gap-2">
                <div className="w-3 h-3 bg-blue-500 rounded" />
                Comm ({issue.commenterDays}d)
              </span>
              <span className="flex items-center gap-2">
                <div className="w-3 h-3 bg-green-500 rounded" />
                Author ({issue.authorDays}d)
              </span>
              <span className="flex items-center gap-2">
                <div className="w-3 h-3 bg-amber-500 rounded" />
                Review ({issue.reviewerDays}d)
              </span>
            </div>
            <div className="h-4 bg-gray-700 rounded-full overflow-hidden flex">
              <div
                className="bg-blue-500 h-full transition-all"
                style={{ width: `${commPercent}%` }}
              />
              <div
                className="bg-green-500 h-full transition-all"
                style={{ width: `${authorPercent}%` }}
              />
              <div
                className="bg-amber-500 h-full transition-all"
                style={{ width: `${reviewerPercent}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>{Math.round(commPercent)}%</span>
              <span>{Math.round(authorPercent)}%</span>
              <span>{Math.round(reviewerPercent)}%</span>
            </div>
          </div>
        </div>

        {/* Team Activity Breakdown */}
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <h4 className="text-white font-medium mb-3">Team Activity Breakdown</h4>
          {memberBreakdown.length === 0 ? (
            <div className="text-gray-500 text-center py-4">No team activity found</div>
          ) : (
            <div className="space-y-2">
              {memberBreakdown.map((member) => {
                const isExpanded = expandedMember === member.username;
                const memberTotal = member.totalDays;
                const memberCommPercent = memberTotal > 0 ? (member.commenterDays / memberTotal) * 100 : 0;
                const memberAuthorPercent = memberTotal > 0 ? (member.authorDays / memberTotal) * 100 : 0;
                const memberReviewerPercent = memberTotal > 0 ? (member.reviewerDays / memberTotal) * 100 : 0;

                return (
                  <div key={member.username} className="bg-gray-700/50 rounded-lg border border-gray-600 overflow-hidden">
                    {/* Member Header */}
                    <button
                      onClick={() => setExpandedMember(isExpanded ? null : member.username)}
                      className="w-full px-3 py-2 flex items-center gap-3 hover:bg-gray-700 transition-colors"
                    >
                      {isExpanded ? (
                        <ChevronDown size={16} className="text-gray-400 flex-shrink-0" />
                      ) : (
                        <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />
                      )}
                      <div className="w-6 h-6 bg-gray-600 rounded-full flex items-center justify-center flex-shrink-0">
                        <User size={12} className="text-gray-400" />
                      </div>
                      <span className="text-white font-medium">@{member.username}</span>
                      
                      {/* Mini progress bar */}
                      <div className="flex-1 mx-4">
                        <div className="h-2 bg-gray-600 rounded-full overflow-hidden flex">
                          <div className="bg-blue-500 h-full" style={{ width: `${memberCommPercent}%` }} />
                          <div className="bg-green-500 h-full" style={{ width: `${memberAuthorPercent}%` }} />
                          <div className="bg-amber-500 h-full" style={{ width: `${memberReviewerPercent}%` }} />
                        </div>
                      </div>

                      {/* Summary badges */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="px-1.5 py-0.5 rounded text-xs bg-blue-900/50 text-blue-400 border border-blue-800">
                          {member.commenterDays}d C
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-xs bg-green-900/50 text-green-400 border border-green-800">
                          {member.authorDays}d A
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-xs bg-amber-900/50 text-amber-400 border border-amber-800">
                          {member.reviewerDays}d R
                        </span>
                        <span className="px-2 py-0.5 rounded text-xs bg-cyan-900/50 text-cyan-400 border border-cyan-800 font-semibold">
                          {member.totalDays}d
                        </span>
                      </div>
                    </button>

                    {/* Expanded: Activity dates */}
                    {isExpanded && (
                      <div className="border-t border-gray-600 px-3 py-2 bg-gray-800/50">
                        <div className="grid grid-cols-3 gap-4 text-sm">
                          {/* Comment Dates */}
                          <div>
                            <div className="flex items-center gap-1 text-blue-400 mb-2">
                              <MessageSquare size={12} />
                              <span className="font-medium">Comments ({member.commenterDays}d)</span>
                            </div>
                            {member.commentActivity.length > 0 ? (
                              <div className="space-y-1">
                                {member.commentActivity.map(activity => (
                                  <div key={activity.date} className="text-xs text-gray-400 font-mono flex items-center gap-2">
                                    <span>{activity.date}</span>
                                    {activity.commentUrl && (
                                      <a
                                        href={activity.commentUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-blue-400 hover:text-blue-300 transition-colors"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <ExternalLink size={10} />
                                      </a>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-xs text-gray-600">No comments</div>
                            )}
                          </div>

                          {/* Author Dates */}
                          <div>
                            <div className="flex items-center gap-1 text-green-400 mb-2">
                              <GitPullRequest size={12} />
                              <span className="font-medium">Authoring ({member.authorDays}d)</span>
                            </div>
                            {member.authorActivity.length > 0 ? (
                              <div className="space-y-1">
                                {member.authorActivity.map(activity => (
                                  <div key={activity.date} className="text-xs text-gray-400 font-mono flex items-center gap-2 flex-wrap">
                                    <span>{activity.date}</span>
                                    {activity.prLinks.map(pr => (
                                      <a
                                        key={pr.number}
                                        href={pr.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-green-400 hover:text-green-300 transition-colors"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        #{pr.number}
                                      </a>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-xs text-gray-600">No authoring</div>
                            )}
                          </div>

                          {/* Reviewer Dates */}
                          <div>
                            <div className="flex items-center gap-1 text-amber-400 mb-2">
                              <CheckCircle size={12} />
                              <span className="font-medium">Reviewing ({member.reviewerDays}d)</span>
                            </div>
                            {member.reviewerActivity.length > 0 ? (
                              <div className="space-y-1">
                                {member.reviewerActivity.map(activity => (
                                  <div key={activity.date} className="text-xs text-gray-400 font-mono flex items-center gap-2 flex-wrap">
                                    <span>{activity.date}</span>
                                    {activity.prLinks.map(pr => (
                                      <a
                                        key={pr.number}
                                        href={pr.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-amber-400 hover:text-amber-300 transition-colors"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        #{pr.number}
                                      </a>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-xs text-gray-600">No reviews</div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default IssuesView;
