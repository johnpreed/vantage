import Dexie, { type EntityTable } from 'dexie';

// ============================================================================
// Types
// ============================================================================

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  repository: string; // owner/repo format
  author: string;
  assignees: string[];
  labels: Label[];
  linkedPRs: LinkedPR[];
  lastTeamComment: string | null; // timestamp of last comment by a team member
  lastSyncedAt: string;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  nodeId: string;
  issueId: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  repository: string;
}

export interface LinkedPR {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  author: string;
  createdAt: string;
  mergedAt: string | null;
}

export interface PullRequest {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  repository: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  lastSyncedAt: string;
}

export interface PRActivity {
  id: string;
  prId: number;
  prNumber: number;
  repository: string;
  type: 'commit' | 'review' | 'review_comment';
  author: string;
  createdAt: string;
}

export interface SyncStatus {
  id: string; // 'global' or repository name
  lastFullSync: string | null;
  lastIncrementalSync: string | null;
  issuesCount: number;
  commentsCount: number;
  status: 'idle' | 'syncing' | 'error';
  errorMessage: string | null;
}

// ============================================================================
// Database Definition
// ============================================================================

class VantageDB extends Dexie {
  issues!: EntityTable<Issue, 'id'>;
  comments!: EntityTable<Comment, 'id'>;
  pullRequests!: EntityTable<PullRequest, 'id'>;
  prActivity!: EntityTable<PRActivity, 'id'>;
  syncStatus!: EntityTable<SyncStatus, 'id'>;

  constructor() {
    super('VantageDB');

    this.version(2).stores({
      // Primary key and indexed fields
      issues: 'id, nodeId, number, state, repository, author, createdAt, updatedAt, closedAt, lastTeamComment, *assignees, *labels.name',
      comments: 'id, nodeId, issueId, author, createdAt, repository',
      pullRequests: 'id, nodeId, number, state, repository, author, createdAt, mergedAt',
      prActivity: 'id, prId, prNumber, repository, type, author, createdAt',
      syncStatus: 'id',
    });
  }
}

export const db = new VantageDB();

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Clear all data from the database
 */
export async function clearAllData(): Promise<void> {
  await db.transaction('rw', [db.issues, db.comments, db.pullRequests, db.prActivity, db.syncStatus], async () => {
    await db.issues.clear();
    await db.comments.clear();
    await db.pullRequests.clear();
    await db.prActivity.clear();
    await db.syncStatus.clear();
  });
}

/**
 * Get issues with stall status
 * - Stale: No team comment in 3 days
 * - Blocked: Contains specific labels or keywords
 */
export async function getStallInsights(
  teamMembers: string[],
  staleDays: number = 3
): Promise<{ stale: Issue[]; blocked: Issue[] }> {
  const staleThreshold = new Date();
  staleThreshold.setDate(staleThreshold.getDate() - staleDays);

  const openIssues = await db.issues
    .where('state')
    .equals('OPEN')
    .toArray();

  const blockedLabels = ['blocked', 'waiting-for-customer', 'needs-info', 'on-hold'];
  const blockedKeywords = ['blocked', 'waiting on', 'pending'];

  const stale: Issue[] = [];
  const blocked: Issue[] = [];

  for (const issue of openIssues) {
    // Check if blocked
    const hasBlockedLabel = issue.labels.some(
      label => blockedLabels.some(bl => label.name.toLowerCase().includes(bl))
    );
    const hasBlockedKeyword = blockedKeywords.some(
      keyword => issue.title.toLowerCase().includes(keyword) || issue.body.toLowerCase().includes(keyword)
    );

    if (hasBlockedLabel || hasBlockedKeyword) {
      blocked.push(issue);
      continue;
    }

    // Check if stale (no team comment in staleDays)
    if (!issue.lastTeamComment || new Date(issue.lastTeamComment) < staleThreshold) {
      // Verify by checking comments
      const issueComments = await db.comments
        .where('issueId')
        .equals(issue.id)
        .toArray();

      const teamComments = issueComments.filter(c => teamMembers.includes(c.author));
      const lastTeamCommentDate = teamComments.length > 0
        ? new Date(Math.max(...teamComments.map(c => new Date(c.createdAt).getTime())))
        : null;

      if (!lastTeamCommentDate || lastTeamCommentDate < staleThreshold) {
        stale.push(issue);
      }
    }
  }

  return { stale, blocked };
}

/**
 * Get issues filtered by label
 */
export async function getIssuesByLabel(labelName: string): Promise<Issue[]> {
  const allIssues = await db.issues.toArray();
  return allIssues.filter(issue =>
    issue.labels.some(label => label.name.toLowerCase().includes(labelName.toLowerCase()))
  );
}

/**
 * Get team member activity stats
 */
export async function getTeamMemberStats(
  teamMembers: string[],
  lookbackDays: number = 180
): Promise<Map<string, { comments: number; issuesClosed: number; linkedPRsCount: number }>> {
  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);
  const lookbackStr = lookbackDate.toISOString();

  const stats = new Map<string, { comments: number; issuesClosed: number; linkedPRsCount: number }>();

  // Get all issues to count linked PRs
  const allIssues = await db.issues.toArray();

  for (const member of teamMembers) {
    // Count comments
    const comments = await db.comments
      .where('author')
      .equals(member)
      .filter(c => c.createdAt >= lookbackStr)
      .count();

    // Count issues closed (where member is in assignees and issue is closed within lookback)
    const closedIssues = await db.issues
      .where('state')
      .equals('CLOSED')
      .filter(issue =>
        issue.assignees.includes(member) &&
        issue.closedAt !== null &&
        issue.closedAt >= lookbackStr
      )
      .count();

    // Count linked PRs authored by this member across all issues
    let linkedPRsCount = 0;
    for (const issue of allIssues) {
      linkedPRsCount += issue.linkedPRs.filter(pr => pr.author === member).length;
    }

    stats.set(member, {
      comments,
      issuesClosed: closedIssues,
      linkedPRsCount,
    });
  }

  return stats;
}

/**
 * Get team members assigned to stalled issues
 */
export async function getEngagementAudit(
  teamMembers: string[],
  stalledIssues: Issue[]
): Promise<Map<string, Issue[]>> {
  const audit = new Map<string, Issue[]>();

  for (const member of teamMembers) {
    const assignedStalledIssues = stalledIssues.filter(issue =>
      issue.assignees.includes(member)
    );
    if (assignedStalledIssues.length > 0) {
      audit.set(member, assignedStalledIssues);
    }
  }

  return audit;
}

/**
 * Search issues by text query
 */
export async function searchIssues(query: string): Promise<Issue[]> {
  const lowerQuery = query.toLowerCase();
  return db.issues
    .filter(issue =>
      issue.title.toLowerCase().includes(lowerQuery) ||
      issue.body.toLowerCase().includes(lowerQuery) ||
      issue.labels.some(l => l.name.toLowerCase().includes(lowerQuery))
    )
    .toArray();
}

/**
 * Get all issues a team member has engaged with (assigned to or commented on)
 */
export async function getMemberEngagedIssues(member: string): Promise<Issue[]> {
  // Get all issue IDs this member has commented on
  const memberComments = await db.comments
    .where('author')
    .equals(member)
    .toArray();
  
  const commentedIssueIds = new Set(memberComments.map(c => c.issueId));
  
  // Get all issues - either assigned to member OR commented on by member
  const allIssues = await db.issues.toArray();
  
  const engagedIssues = allIssues.filter(issue =>
    issue.assignees.includes(member) || commentedIssueIds.has(issue.id)
  );
  
  // Sort by updated date descending
  return engagedIssues.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * AoR type for expertise calculation
 */
export interface AorDefinition {
  id: string;
  name: string;
  terms: string[];
}

/**
 * Calculate AoR expertise based on issue titles
 */
export function calculateAorExpertise(
  issues: Issue[],
  aors: AorDefinition[]
): Map<string, { count: number; issues: Issue[] }> {
  const expertise = new Map<string, { count: number; issues: Issue[] }>();
  
  // Initialize all AoRs
  for (const aor of aors) {
    expertise.set(aor.id, { count: 0, issues: [] });
  }
  
  // Check each issue against each AoR
  for (const issue of issues) {
    const titleLower = issue.title.toLowerCase();
    
    for (const aor of aors) {
      // Check if any term matches the issue title
      const matches = aor.terms.some(term => 
        titleLower.includes(term.toLowerCase())
      );
      
      if (matches) {
        const current = expertise.get(aor.id)!;
        current.count++;
        current.issues.push(issue);
      }
    }
  }
  
  return expertise;
}

/**
 * Get team members engaged on a specific issue (assigned or commented)
 */
export async function getIssueEngagedMembers(
  issueId: number,
  teamMembers: string[]
): Promise<string[]> {
  // Get issue
  const issue = await db.issues.get(issueId);
  if (!issue) return [];
  
  // Get comments on this issue by team members
  const issueComments = await db.comments
    .where('issueId')
    .equals(issueId)
    .toArray();
  
  const engagedMembers = new Set<string>();
  
  // Add assigned team members
  for (const assignee of issue.assignees) {
    if (teamMembers.includes(assignee)) {
      engagedMembers.add(assignee);
    }
  }
  
  // Add team members who commented
  for (const comment of issueComments) {
    if (teamMembers.includes(comment.author)) {
      engagedMembers.add(comment.author);
    }
  }
  
  return Array.from(engagedMembers);
}

/**
 * Get comment counts for multiple issues at once (batch operation)
 */
export async function getBatchCommentCounts(
  issueIds: number[]
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  
  // Initialize all to 0
  for (const id of issueIds) {
    result.set(id, 0);
  }
  
  // Get all comments for these issues
  const allComments = await db.comments
    .where('issueId')
    .anyOf(issueIds)
    .toArray();
  
  // Count comments per issue
  for (const comment of allComments) {
    result.set(comment.issueId, (result.get(comment.issueId) || 0) + 1);
  }
  
  return result;
}

export interface IssueStatus {
  isStalled: boolean;
  isAwaitingReply: boolean;
}

/**
 * Get status for multiple issues at once (stalled, awaiting reply)
 * - Stalled: No team comment in staleDays
 * - Awaiting reply: Last comment is not from team and contains a question mark
 */
export async function getBatchIssueStatus(
  issueIds: number[],
  teamMembers: string[],
  staleDays: number = 3
): Promise<Map<number, IssueStatus>> {
  const result = new Map<number, IssueStatus>();
  
  const staleThreshold = new Date();
  staleThreshold.setDate(staleThreshold.getDate() - staleDays);
  
  // Get all comments for these issues
  const allComments = await db.comments
    .where('issueId')
    .anyOf(issueIds)
    .toArray();
  
  // Group comments by issue and sort by date
  const commentsByIssue = new Map<number, typeof allComments>();
  for (const comment of allComments) {
    if (!commentsByIssue.has(comment.issueId)) {
      commentsByIssue.set(comment.issueId, []);
    }
    commentsByIssue.get(comment.issueId)!.push(comment);
  }
  
  // Sort each issue's comments by date
  for (const [issueId, comments] of commentsByIssue) {
    comments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    commentsByIssue.set(issueId, comments);
  }
  
  // Calculate status for each issue
  for (const issueId of issueIds) {
    const comments = commentsByIssue.get(issueId) || [];
    const teamComments = comments.filter(c => teamMembers.includes(c.author));
    
    // Check if stalled (no team comment in staleDays)
    const lastTeamComment = teamComments[0]; // Already sorted descending
    const isStalled = !lastTeamComment || new Date(lastTeamComment.createdAt) < staleThreshold;
    
    // Check if awaiting reply (last comment not from team and has question mark)
    const lastComment = comments[0];
    const isAwaitingReply = lastComment 
      && !teamMembers.includes(lastComment.author)
      && lastComment.body.includes('?');
    
    result.set(issueId, { isStalled, isAwaitingReply: isAwaitingReply || false });
  }
  
  return result;
}

/**
 * Get engaged team members for multiple issues at once (batch operation)
 */
export async function getBatchIssueEngagedMembers(
  issueIds: number[],
  teamMembers: string[]
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  
  // Get all issues
  const issues = await db.issues.where('id').anyOf(issueIds).toArray();
  const issueMap = new Map(issues.map(i => [i.id, i]));
  
  // Get all comments for these issues
  const allComments = await db.comments
    .where('issueId')
    .anyOf(issueIds)
    .toArray();
  
  // Group comments by issue
  const commentsByIssue = new Map<number, typeof allComments>();
  for (const comment of allComments) {
    if (!commentsByIssue.has(comment.issueId)) {
      commentsByIssue.set(comment.issueId, []);
    }
    commentsByIssue.get(comment.issueId)!.push(comment);
  }
  
  // Calculate engaged members for each issue
  for (const issueId of issueIds) {
    const issue = issueMap.get(issueId);
    const engagedMembers = new Set<string>();
    
    if (issue) {
      // Add assigned team members
      for (const assignee of issue.assignees) {
        if (teamMembers.includes(assignee)) {
          engagedMembers.add(assignee);
        }
      }
    }
    
    // Add team members who commented
    const comments = commentsByIssue.get(issueId) || [];
    for (const comment of comments) {
      if (teamMembers.includes(comment.author)) {
        engagedMembers.add(comment.author);
      }
    }
    
    result.set(issueId, Array.from(engagedMembers));
  }
  
  return result;
}

/**
 * Update sync status for a repository
 */
export async function updateSyncStatus(
  repoId: string,
  updates: Partial<SyncStatus>
): Promise<void> {
  const existing = await db.syncStatus.get(repoId);
  if (existing) {
    await db.syncStatus.update(repoId, updates);
  } else {
    await db.syncStatus.add({
      id: repoId,
      lastFullSync: null,
      lastIncrementalSync: null,
      issuesCount: 0,
      commentsCount: 0,
      status: 'idle',
      errorMessage: null,
      ...updates,
    });
  }
}

/**
 * Bulk upsert issues
 */
export async function upsertIssues(issues: Issue[]): Promise<void> {
  await db.issues.bulkPut(issues);
}

/**
 * Bulk upsert comments
 */
export async function upsertComments(comments: Comment[]): Promise<void> {
  await db.comments.bulkPut(comments);
}

/**
 * Bulk upsert pull requests
 */
export async function upsertPullRequests(prs: PullRequest[]): Promise<void> {
  await db.pullRequests.bulkPut(prs);
}

/**
 * Bulk upsert PR activity
 */
export async function upsertPRActivity(activities: PRActivity[]): Promise<void> {
  await db.prActivity.bulkPut(activities);
}

export default db;
