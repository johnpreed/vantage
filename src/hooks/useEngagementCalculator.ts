import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Issue, type Comment, type PRActivity } from '../db';

// ============================================================================
// Types
// ============================================================================

export interface EngagementMetrics {
  commDays: number;           // Unique UTC days with issue comments
  devDays: number;            // Unique UTC days with PR activity
  totalActiveDays: number;    // Union of all unique activity days
  commDayCredits: number;     // Context-adjusted communication day credits
  devDayCredits: number;      // Context-adjusted development day credits
}

export interface ActivityDetail {
  date: string;           // UTC date key (YYYY-MM-DD)
  commentCount: number;   // Number of comments on this date
  prActivityCount: number;// Number of PR activities on this date (total)
  authorActivityCount: number;  // Commits on PRs authored by user
  reviewActivityCount: number;  // Reviews/comments on PRs authored by others
}

export interface IssueEngagement {
  issueId: number;
  commDays: number;
  devDays: number;         // Unique days with any PR activity
  authorDays: number;      // Unique days with commits on PRs user authored
  reviewerDays: number;    // Unique days with reviews/comments on others' PRs
  commDayCredits: number;  // With context switch factor applied
  devDayCredits: number;   // With context switch factor applied
  activityDetails: ActivityDetail[];  // Per-date breakdown
  totalComments: number;   // Total comments on this issue
  totalPRActivities: number; // Total PR activities on this issue
  totalAuthorActivities: number;  // Total commits on PRs user authored
  totalReviewActivities: number;  // Total reviews/comments on others' PRs
}

export interface TeamMemberEngagement {
  username: string;
  totalActiveDays: number;
  commDays: number;
  devDays: number;         // Unique days with any PR activity
  authorDays: number;      // Unique days with commits on PRs user authored
  reviewerDays: number;    // Unique days with reviews/comments on others' PRs
  commDayCredits: number;
  devDayCredits: number;
  topAors: AorActivity[];
  issueEngagements: Map<number, IssueEngagement>;
}

export interface AorActivity {
  aorId: string;
  aorName: string;
  activityDays: number;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert a date string to a UTC date key (YYYY-MM-DD)
 */
function toUtcDateKey(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toISOString().split('T')[0];
}

/**
 * Calculate unique activity days from a list of date strings
 */
function countUniqueDays(dates: string[]): number {
  const uniqueDays = new Set(dates.map(toUtcDateKey));
  return uniqueDays.size;
}

/**
 * Group activities by UTC date
 */
function groupByDate<T>(items: T[], getDate: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const dateKey = toUtcDateKey(getDate(item));
    if (!groups.has(dateKey)) {
      groups.set(dateKey, []);
    }
    groups.get(dateKey)!.push(item);
  }
  return groups;
}

// ============================================================================
// Core Calculation Functions
// ============================================================================

/**
 * Calculate engagement metrics for a single user on a specific issue
 */
export function calculateIssueEngagement(
  issueId: number,
  username: string,
  comments: Comment[],
  prActivities: PRActivity[],
  issue: Issue,
  allUserComments: Comment[],
  allUserPRActivities: PRActivity[]
): IssueEngagement {
  // Filter comments for this user on this issue
  const userIssueComments = comments.filter(
    c => c.issueId === issueId && c.author === username
  );
  
  // Build map of PR ID -> PR author for linked PRs
  const prAuthorMap = new Map<number, string>();
  for (const pr of issue.linkedPRs) {
    prAuthorMap.set(pr.id, pr.author);
  }
  
  // Get PR IDs linked to this issue
  const linkedPRIds = new Set(issue.linkedPRs.map(pr => pr.id));
  
  // Filter PR activities for this user on linked PRs
  const userIssuePRActivities = prActivities.filter(
    a => linkedPRIds.has(a.prId) && a.author === username
  );
  
  // Split into author activities (commits on PRs user authored) and reviewer activities (reviews on others' PRs)
  const authorActivities = userIssuePRActivities.filter(a => {
    const prAuthor = prAuthorMap.get(a.prId);
    // Author activity = commit on a PR they authored
    return a.type === 'commit' && prAuthor === username;
  });
  
  const reviewerActivities = userIssuePRActivities.filter(a => {
    const prAuthor = prAuthorMap.get(a.prId);
    // Reviewer activity = review or review_comment on a PR authored by someone else
    return (a.type === 'review' || a.type === 'review_comment') && prAuthor !== username;
  });

  // Calculate raw unique days
  const commDays = countUniqueDays(userIssueComments.map(c => c.createdAt));
  const devDays = countUniqueDays(userIssuePRActivities.map(a => a.createdAt));
  const authorDays = countUniqueDays(authorActivities.map(a => a.createdAt));
  const reviewerDays = countUniqueDays(reviewerActivities.map(a => a.createdAt));

  // Calculate context switch factor for communication days
  let commDayCredits = 0;
  const commentsByDate = groupByDate(userIssueComments, c => c.createdAt);
  const allCommentsByDate = groupByDate(allUserComments, c => c.createdAt);
  
  for (const [dateKey] of commentsByDate) {
    const allCommentsOnDay = allCommentsByDate.get(dateKey) || [];
    const issuesOnDay = new Set(allCommentsOnDay.map(c => c.issueId));
    const numIssues = issuesOnDay.size;
    commDayCredits += numIssues > 0 ? 1 / numIssues : 0;
  }

  // Calculate context switch factor for development days
  let devDayCredits = 0;
  const prActivityByDate = groupByDate(userIssuePRActivities, a => a.createdAt);
  const allPRActivityByDate = groupByDate(allUserPRActivities, a => a.createdAt);
  
  for (const [dateKey] of prActivityByDate) {
    // Count unique issues the user worked on that day (via PR activities)
    const allActivitiesOnDay = allPRActivityByDate.get(dateKey) || [];
    // We need to map PR activities back to issues
    // For simplicity, count unique PRs as a proxy for context switches
    const prsOnDay = new Set(allActivitiesOnDay.map(a => a.prId));
    const numPRs = prsOnDay.size;
    devDayCredits += numPRs > 0 ? 1 / numPRs : 0;
  }

  // Build per-date activity details
  const allDates = new Set<string>();
  for (const c of userIssueComments) {
    allDates.add(toUtcDateKey(c.createdAt));
  }
  for (const a of userIssuePRActivities) {
    allDates.add(toUtcDateKey(a.createdAt));
  }

  const activityDetails: ActivityDetail[] = Array.from(allDates)
    .sort((a, b) => b.localeCompare(a)) // Most recent first
    .map(dateKey => ({
      date: dateKey,
      commentCount: userIssueComments.filter(c => toUtcDateKey(c.createdAt) === dateKey).length,
      prActivityCount: userIssuePRActivities.filter(a => toUtcDateKey(a.createdAt) === dateKey).length,
      authorActivityCount: authorActivities.filter(a => toUtcDateKey(a.createdAt) === dateKey).length,
      reviewActivityCount: reviewerActivities.filter(a => toUtcDateKey(a.createdAt) === dateKey).length,
    }));

  return {
    issueId,
    commDays,
    devDays,
    authorDays,
    reviewerDays,
    commDayCredits,
    devDayCredits,
    activityDetails,
    totalComments: userIssueComments.length,
    totalPRActivities: userIssuePRActivities.length,
    totalAuthorActivities: authorActivities.length,
    totalReviewActivities: reviewerActivities.length,
  };
}

/**
 * Calculate total engagement metrics for a team member
 */
export function calculateMemberEngagement(
  username: string,
  comments: Comment[],
  prActivities: PRActivity[],
  issues: Issue[],
  aors: Array<{ id: string; name: string; terms: string[] }>
): TeamMemberEngagement {
  // Build set of all PR IDs that are linked to any tracked issue
  // Also build map of PR ID -> PR author for author/reviewer classification
  const linkedPRIds = new Set<number>();
  const prAuthorMap = new Map<number, string>();
  for (const issue of issues) {
    for (const pr of issue.linkedPRs) {
      linkedPRIds.add(pr.id);
      prAuthorMap.set(pr.id, pr.author);
    }
  }

  // Filter data for this user
  const userComments = comments.filter(c => c.author === username);
  // Only count PR activities on PRs that are linked to tracked issues
  const userPRActivities = prActivities.filter(
    a => a.author === username && linkedPRIds.has(a.prId)
  );
  
  // Split into author activities (commits on PRs user authored) and reviewer activities (reviews on others' PRs)
  const authorActivities = userPRActivities.filter(a => {
    const prAuthor = prAuthorMap.get(a.prId);
    // Author activity = commit on a PR they authored
    return a.type === 'commit' && prAuthor === username;
  });
  
  const reviewerActivities = userPRActivities.filter(a => {
    const prAuthor = prAuthorMap.get(a.prId);
    // Reviewer activity = review or review_comment on a PR authored by someone else
    return (a.type === 'review' || a.type === 'review_comment') && prAuthor !== username;
  });

  // Calculate raw unique days
  const commDates = userComments.map(c => c.createdAt);
  const devDates = userPRActivities.map(a => a.createdAt);
  const authorDates = authorActivities.map(a => a.createdAt);
  const reviewerDates = reviewerActivities.map(a => a.createdAt);
  
  const commDaysSet = new Set(commDates.map(toUtcDateKey));
  const devDaysSet = new Set(devDates.map(toUtcDateKey));
  const authorDaysSet = new Set(authorDates.map(toUtcDateKey));
  const reviewerDaysSet = new Set(reviewerDates.map(toUtcDateKey));
  const allDaysSet = new Set([...commDaysSet, ...devDaysSet]);

  const commDays = commDaysSet.size;
  const devDays = devDaysSet.size;
  const authorDays = authorDaysSet.size;
  const reviewerDays = reviewerDaysSet.size;
  const totalActiveDays = allDaysSet.size;

  // Calculate context-adjusted credits
  // Group comments by date, then for each date calculate 1/N credit per issue
  const commentsByDate = groupByDate(userComments, c => c.createdAt);
  let commDayCredits = 0;
  
  for (const [,] of commentsByDate) {
    // Each day the user has comments = 1 day credit total, split across issues
    commDayCredits += 1; // Total credit for the day is 1, split across issues
  }

  // Group PR activities by date
  const prActivityByDate = groupByDate(userPRActivities, a => a.createdAt);
  let devDayCredits = 0;
  
  for (const [,] of prActivityByDate) {
    // Each day the user has PR activity = 1 day credit total, split across PRs
    devDayCredits += 1; // Total credit for the day is 1, split across PRs
  }

  // Calculate per-issue engagement
  const issueEngagements = new Map<number, IssueEngagement>();
  const issuesWithActivity = new Set<number>();
  
  // Find issues the user has commented on
  for (const comment of userComments) {
    issuesWithActivity.add(comment.issueId);
  }
  
  // Find issues linked to PRs the user has activity on
  const userPRIds = new Set(userPRActivities.map(a => a.prId));
  for (const issue of issues) {
    for (const pr of issue.linkedPRs) {
      if (userPRIds.has(pr.id)) {
        issuesWithActivity.add(issue.id);
      }
    }
  }

  // Calculate engagement for each issue
  const issueMap = new Map(issues.map(i => [i.id, i]));
  for (const issueId of issuesWithActivity) {
    const issue = issueMap.get(issueId);
    if (issue) {
      const engagement = calculateIssueEngagement(
        issueId,
        username,
        comments,
        prActivities,
        issue,
        userComments,
        userPRActivities
      );
      issueEngagements.set(issueId, engagement);
    }
  }

  // Calculate AoR activity
  const aorActivityDays = new Map<string, Set<string>>();
  
  for (const aor of aors) {
    aorActivityDays.set(aor.id, new Set());
  }

  // For each issue the user engaged with, check which AoRs match
  for (const issueId of issuesWithActivity) {
    const issue = issueMap.get(issueId);
    if (!issue) continue;
    
    const titleLower = issue.title.toLowerCase();
    const labelNames = issue.labels.map(l => l.name.toLowerCase());
    
    // Get activity dates for this issue
    const issueCommDates = userComments
      .filter(c => c.issueId === issueId)
      .map(c => toUtcDateKey(c.createdAt));
    
    const linkedPRIds = new Set(issue.linkedPRs.map(pr => pr.id));
    const issueDevDates = userPRActivities
      .filter(a => linkedPRIds.has(a.prId))
      .map(a => toUtcDateKey(a.createdAt));
    
    const allIssueDates = [...new Set([...issueCommDates, ...issueDevDates])];
    
    for (const aor of aors) {
      const matches = aor.terms.some(term => {
        const termLower = term.toLowerCase();
        return titleLower.includes(termLower) || labelNames.some(l => l.includes(termLower));
      });
      
      if (matches) {
        const aorDays = aorActivityDays.get(aor.id)!;
        for (const date of allIssueDates) {
          aorDays.add(date);
        }
      }
    }
  }

  // Convert to top AoRs array
  const topAors: AorActivity[] = aors
    .map(aor => ({
      aorId: aor.id,
      aorName: aor.name,
      activityDays: aorActivityDays.get(aor.id)?.size || 0,
    }))
    .filter(a => a.activityDays > 0)
    .sort((a, b) => b.activityDays - a.activityDays)
    .slice(0, 3);

  return {
    username,
    totalActiveDays,
    commDays,
    devDays,
    authorDays,
    reviewerDays,
    commDayCredits,
    devDayCredits,
    topAors,
    issueEngagements,
  };
}

// ============================================================================
// React Hooks
// ============================================================================

/**
 * Hook to calculate engagement metrics for a specific user
 */
export function useUserEngagement(
  username: string | null,
  aors: Array<{ id: string; name: string; terms: string[] }> = []
): TeamMemberEngagement | null {
  const comments = useLiveQuery(() => db.comments.toArray(), []);
  const prActivities = useLiveQuery(() => db.prActivity.toArray(), []);
  const issues = useLiveQuery(() => db.issues.toArray(), []);

  return useMemo(() => {
    if (!username || !comments || !prActivities || !issues) {
      return null;
    }

    return calculateMemberEngagement(username, comments, prActivities, issues, aors);
  }, [username, comments, prActivities, issues, aors]);
}

/**
 * Hook to calculate engagement metrics for all team members
 */
export function useTeamEngagement(
  teamMembers: string[],
  aors: Array<{ id: string; name: string; terms: string[] }> = []
): Map<string, TeamMemberEngagement> {
  const comments = useLiveQuery(() => db.comments.toArray(), []);
  const prActivities = useLiveQuery(() => db.prActivity.toArray(), []);
  const issues = useLiveQuery(() => db.issues.toArray(), []);

  return useMemo(() => {
    const result = new Map<string, TeamMemberEngagement>();
    
    if (!comments || !prActivities || !issues) {
      return result;
    }

    for (const member of teamMembers) {
      const engagement = calculateMemberEngagement(member, comments, prActivities, issues, aors);
      result.set(member, engagement);
    }

    return result;
  }, [teamMembers, comments, prActivities, issues, aors]);
}

/**
 * Hook to calculate engagement metrics for a specific issue
 */
export function useIssueEngagement(
  issueId: number,
  teamMembers: string[]
): Map<string, IssueEngagement> {
  const comments = useLiveQuery(() => db.comments.toArray(), []);
  const prActivities = useLiveQuery(() => db.prActivity.toArray(), []);
  const issue = useLiveQuery(() => db.issues.get(issueId), [issueId]);

  return useMemo(() => {
    const result = new Map<string, IssueEngagement>();
    
    if (!comments || !prActivities || !issue) {
      return result;
    }

    // Get all user comments and PR activities for context switch calculation
    for (const member of teamMembers) {
      const userComments = comments.filter(c => c.author === member);
      const userPRActivities = prActivities.filter(a => a.author === member);
      
      // Check if user has any engagement with this issue
      const hasComments = userComments.some(c => c.issueId === issueId);
      const linkedPRIds = new Set(issue.linkedPRs.map(pr => pr.id));
      const hasPRActivity = userPRActivities.some(a => linkedPRIds.has(a.prId));
      
      if (hasComments || hasPRActivity) {
        const engagement = calculateIssueEngagement(
          issueId,
          member,
          comments,
          prActivities,
          issue,
          userComments,
          userPRActivities
        );
        result.set(member, engagement);
      }
    }

    return result;
  }, [issueId, teamMembers, comments, prActivities, issue]);
}

/**
 * Hook to get aggregated engagement for a single issue across all team members
 */
export function useIssueEffort(
  issueId: number,
  teamMembers: string[]
): { commDays: number; devDays: number } | null {
  const engagements = useIssueEngagement(issueId, teamMembers);

  return useMemo(() => {
    if (engagements.size === 0) {
      return null;
    }

    // Sum up engagement across all team members for this issue
    let totalCommDays = 0;
    let totalDevDays = 0;

    for (const engagement of engagements.values()) {
      totalCommDays += engagement.commDays;
      totalDevDays += engagement.devDays;
    }

    return {
      commDays: totalCommDays,
      devDays: totalDevDays,
    };
  }, [engagements]);
}

/**
 * Batch calculation for all issues - more efficient than individual hooks
 */
export function useBatchIssueEffort(
  issueIds: number[],
  teamMembers: string[]
): Map<number, { commDays: number; devDays: number }> {
  const comments = useLiveQuery(() => db.comments.toArray(), []);
  const prActivities = useLiveQuery(() => db.prActivity.toArray(), []);
  const issues = useLiveQuery(
    async () => {
      if (issueIds.length === 0) return [] as Issue[];
      return db.issues.where('id').anyOf(issueIds).toArray();
    },
    [issueIds.join(',')]
  );

  return useMemo(() => {
    const result = new Map<number, { commDays: number; devDays: number }>();
    
    if (!comments || !prActivities || !issues || issues.length === 0) {
      return result;
    }

    const issueMap = new Map(issues.map(i => [i.id, i]));
    
    // Pre-group data for efficiency
    const commentsByIssue = new Map<number, Comment[]>();
    for (const comment of comments) {
      if (!commentsByIssue.has(comment.issueId)) {
        commentsByIssue.set(comment.issueId, []);
      }
      commentsByIssue.get(comment.issueId)!.push(comment);
    }

    // Build PR to issue mapping
    const prToIssues = new Map<number, number[]>();
    for (const issue of issues) {
      for (const pr of issue.linkedPRs) {
        if (!prToIssues.has(pr.id)) {
          prToIssues.set(pr.id, []);
        }
        prToIssues.get(pr.id)!.push(issue.id);
      }
    }

    // Group PR activities by issue
    const prActivityByIssue = new Map<number, PRActivity[]>();
    for (const activity of prActivities) {
      const linkedIssueIds = prToIssues.get(activity.prId) || [];
      for (const issueId of linkedIssueIds) {
        if (!prActivityByIssue.has(issueId)) {
          prActivityByIssue.set(issueId, []);
        }
        prActivityByIssue.get(issueId)!.push(activity);
      }
    }

    // Calculate effort for each issue
    for (const issueId of issueIds) {
      const issue = issueMap.get(issueId);
      if (!issue) continue;

      const issueComments = commentsByIssue.get(issueId) || [];
      const issuePRActivities = prActivityByIssue.get(issueId) || [];

      // Filter to team members only
      const teamComments = issueComments.filter(c => teamMembers.includes(c.author));
      const teamPRActivities = issuePRActivities.filter(a => teamMembers.includes(a.author));

      // Count unique days
      const commDays = countUniqueDays(teamComments.map(c => c.createdAt));
      const devDays = countUniqueDays(teamPRActivities.map(a => a.createdAt));

      if (commDays > 0 || devDays > 0) {
        result.set(issueId, { commDays, devDays });
      }
    }

    return result;
  }, [issueIds.join(','), teamMembers.join(','), comments, prActivities, issues]);
}

// ============================================================================
// Team-Level Issue Effort (counts each member's contribution separately)
// ============================================================================

export interface IssueTeamEffort {
  issueId: number;
  issueNumber: number;
  repository: string;
  title: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  commenterDays: number;   // Sum of unique (member, date) pairs for comments
  authorDays: number;      // Sum of unique (member, date) pairs for commits on own PRs
  reviewerDays: number;    // Sum of unique (member, date) pairs for reviews on others' PRs
  totalEffortDays: number; // Sum of all effort days
  contributors: string[];  // List of team members who contributed
}

/**
 * Hook to calculate team-level effort for all issues
 * Each team member's days are counted separately (not deduplicated across members)
 */
export function useAllIssuesTeamEffort(
  teamMembers: string[]
): IssueTeamEffort[] {
  const comments = useLiveQuery(() => db.comments.toArray(), []);
  const prActivities = useLiveQuery(() => db.prActivity.toArray(), []);
  const issues = useLiveQuery(() => db.issues.toArray(), []);

  return useMemo(() => {
    if (!comments || !prActivities || !issues || issues.length === 0) {
      return [];
    }

    const teamMemberSet = new Set(teamMembers);
    
    // Build PR author map (PR ID -> author)
    const prAuthorMap = new Map<number, string>();
    for (const issue of issues) {
      for (const pr of issue.linkedPRs) {
        prAuthorMap.set(pr.id, pr.author);
      }
    }

    // Pre-group comments by issue
    const commentsByIssue = new Map<number, Comment[]>();
    for (const comment of comments) {
      if (!teamMemberSet.has(comment.author)) continue;
      if (!commentsByIssue.has(comment.issueId)) {
        commentsByIssue.set(comment.issueId, []);
      }
      commentsByIssue.get(comment.issueId)!.push(comment);
    }

    // Build PR to issue mapping
    const prToIssues = new Map<number, number[]>();
    for (const issue of issues) {
      for (const pr of issue.linkedPRs) {
        if (!prToIssues.has(pr.id)) {
          prToIssues.set(pr.id, []);
        }
        prToIssues.get(pr.id)!.push(issue.id);
      }
    }

    // Group PR activities by issue
    const prActivityByIssue = new Map<number, PRActivity[]>();
    for (const activity of prActivities) {
      if (!teamMemberSet.has(activity.author)) continue;
      const linkedIssueIds = prToIssues.get(activity.prId) || [];
      for (const issueId of linkedIssueIds) {
        if (!prActivityByIssue.has(issueId)) {
          prActivityByIssue.set(issueId, []);
        }
        prActivityByIssue.get(issueId)!.push(activity);
      }
    }

    // Calculate effort for each issue
    const results: IssueTeamEffort[] = [];
    
    for (const issue of issues) {
      const issueComments = commentsByIssue.get(issue.id) || [];
      const issuePRActivities = prActivityByIssue.get(issue.id) || [];
      
      // Build set of (member, date) pairs for commenter days
      const commenterPairs = new Set<string>();
      for (const comment of issueComments) {
        const dateKey = toUtcDateKey(comment.createdAt);
        commenterPairs.add(`${comment.author}|${dateKey}`);
      }
      
      // Build sets for author and reviewer days
      const authorPairs = new Set<string>();
      const reviewerPairs = new Set<string>();
      const contributors = new Set<string>();
      
      for (const activity of issuePRActivities) {
        const dateKey = toUtcDateKey(activity.createdAt);
        const prAuthor = prAuthorMap.get(activity.prId);
        
        if (activity.type === 'commit' && prAuthor === activity.author) {
          // Author activity: commit on a PR they authored
          authorPairs.add(`${activity.author}|${dateKey}`);
        } else if ((activity.type === 'review' || activity.type === 'review_comment') && prAuthor !== activity.author) {
          // Reviewer activity: review on a PR authored by someone else
          reviewerPairs.add(`${activity.author}|${dateKey}`);
        }
        
        contributors.add(activity.author);
      }
      
      // Add commenters to contributors
      for (const comment of issueComments) {
        contributors.add(comment.author);
      }
      
      const commenterDays = commenterPairs.size;
      const authorDays = authorPairs.size;
      const reviewerDays = reviewerPairs.size;
      const totalEffortDays = commenterDays + authorDays + reviewerDays;
      
      // Only include issues with some team activity
      if (totalEffortDays > 0) {
        results.push({
          issueId: issue.id,
          issueNumber: issue.number,
          repository: issue.repository,
          title: issue.title,
          state: issue.state,
          url: issue.url,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          closedAt: issue.closedAt,
          commenterDays,
          authorDays,
          reviewerDays,
          totalEffortDays,
          contributors: Array.from(contributors).sort(),
        });
      }
    }

    // Sort by total effort descending
    results.sort((a, b) => b.totalEffortDays - a.totalEffortDays);
    
    return results;
  }, [teamMembers.join(','), comments, prActivities, issues]);
}

// ============================================================================
// Per-Member Issue Breakdown
// ============================================================================

export interface PRLink {
  number: number;
  url: string;
}

export interface DateActivity {
  date: string;
  commentUrl?: string;  // URL to last comment on this date
  prLinks: PRLink[];    // PRs involved on this date (for author/reviewer)
}

export interface MemberIssueContribution {
  username: string;
  commenterDays: number;
  authorDays: number;
  reviewerDays: number;
  totalDays: number;
  // Detailed activity with links
  commentActivity: DateActivity[];
  authorActivity: DateActivity[];
  reviewerActivity: DateActivity[];
}

/**
 * Hook to get per-member breakdown for a specific issue
 */
export function useIssueMemberBreakdown(
  issueId: number | null,
  teamMembers: string[]
): MemberIssueContribution[] {
  const comments = useLiveQuery(() => db.comments.toArray(), []);
  const prActivities = useLiveQuery(() => db.prActivity.toArray(), []);
  const issue = useLiveQuery(
    () => issueId ? db.issues.get(issueId) : undefined,
    [issueId]
  );

  return useMemo(() => {
    if (!issueId || !comments || !prActivities || !issue) {
      return [];
    }

    const teamMemberSet = new Set(teamMembers);
    
    // Build PR maps for this issue's linked PRs
    const prAuthorMap = new Map<number, string>();
    const prInfoMap = new Map<number, PRLink>();
    for (const pr of issue.linkedPRs) {
      prAuthorMap.set(pr.id, pr.author);
      prInfoMap.set(pr.id, { number: pr.number, url: pr.url });
    }
    const linkedPRIds = new Set(issue.linkedPRs.map(pr => pr.id));

    // Filter comments for this issue by team members
    const issueComments = comments.filter(
      c => c.issueId === issueId && teamMemberSet.has(c.author)
    );

    // Filter PR activities for this issue's linked PRs by team members
    const issuePRActivities = prActivities.filter(
      a => linkedPRIds.has(a.prId) && teamMemberSet.has(a.author)
    );

    // Build per-member contributions with detailed link info
    const memberContributions = new Map<string, {
      commentsByDate: Map<string, { lastCommentId: number; lastCommentTime: string }>;
      authorByDate: Map<string, Set<number>>;  // date -> Set of prIds
      reviewerByDate: Map<string, Set<number>>; // date -> Set of prIds
    }>();

    // Process comments - track last comment per date
    for (const comment of issueComments) {
      if (!memberContributions.has(comment.author)) {
        memberContributions.set(comment.author, {
          commentsByDate: new Map(),
          authorByDate: new Map(),
          reviewerByDate: new Map(),
        });
      }
      const dateKey = toUtcDateKey(comment.createdAt);
      const contrib = memberContributions.get(comment.author)!;
      
      const existing = contrib.commentsByDate.get(dateKey);
      if (!existing || comment.createdAt > existing.lastCommentTime) {
        contrib.commentsByDate.set(dateKey, {
          lastCommentId: comment.id,
          lastCommentTime: comment.createdAt,
        });
      }
    }

    // Process PR activities
    for (const activity of issuePRActivities) {
      if (!memberContributions.has(activity.author)) {
        memberContributions.set(activity.author, {
          commentsByDate: new Map(),
          authorByDate: new Map(),
          reviewerByDate: new Map(),
        });
      }
      
      const dateKey = toUtcDateKey(activity.createdAt);
      const prAuthor = prAuthorMap.get(activity.prId);
      const contrib = memberContributions.get(activity.author)!;
      
      if (activity.type === 'commit' && prAuthor === activity.author) {
        // Author activity: commit on a PR they authored
        if (!contrib.authorByDate.has(dateKey)) {
          contrib.authorByDate.set(dateKey, new Set());
        }
        contrib.authorByDate.get(dateKey)!.add(activity.prId);
      } else if ((activity.type === 'review' || activity.type === 'review_comment') && prAuthor !== activity.author) {
        // Reviewer activity: review on a PR authored by someone else
        if (!contrib.reviewerByDate.has(dateKey)) {
          contrib.reviewerByDate.set(dateKey, new Set());
        }
        contrib.reviewerByDate.get(dateKey)!.add(activity.prId);
      }
    }

    // Convert to array with proper link structures
    const results: MemberIssueContribution[] = [];
    for (const [username, contrib] of memberContributions) {
      const commenterDays = contrib.commentsByDate.size;
      const authorDays = contrib.authorByDate.size;
      const reviewerDays = contrib.reviewerByDate.size;
      const totalDays = commenterDays + authorDays + reviewerDays;

      if (totalDays > 0) {
        // Build comment activity with URLs
        const commentActivity: DateActivity[] = Array.from(contrib.commentsByDate.entries())
          .map(([date, info]) => ({
            date,
            commentUrl: `${issue.url}#issuecomment-${info.lastCommentId}`,
            prLinks: [],
          }))
          .sort((a, b) => b.date.localeCompare(a.date));

        // Build author activity with PR links
        const authorActivity: DateActivity[] = Array.from(contrib.authorByDate.entries())
          .map(([date, prIds]) => ({
            date,
            prLinks: Array.from(prIds)
              .map(prId => prInfoMap.get(prId)!)
              .filter(Boolean)
              .sort((a, b) => a.number - b.number),
          }))
          .sort((a, b) => b.date.localeCompare(a.date));

        // Build reviewer activity with PR links
        const reviewerActivity: DateActivity[] = Array.from(contrib.reviewerByDate.entries())
          .map(([date, prIds]) => ({
            date,
            prLinks: Array.from(prIds)
              .map(prId => prInfoMap.get(prId)!)
              .filter(Boolean)
              .sort((a, b) => a.number - b.number),
          }))
          .sort((a, b) => b.date.localeCompare(a.date));

        results.push({
          username,
          commenterDays,
          authorDays,
          reviewerDays,
          totalDays,
          commentActivity,
          authorActivity,
          reviewerActivity,
        });
      }
    }

    // Sort by total days descending
    results.sort((a, b) => b.totalDays - a.totalDays);
    
    return results;
  }, [issueId, teamMembers.join(','), comments, prActivities, issue]);
}
