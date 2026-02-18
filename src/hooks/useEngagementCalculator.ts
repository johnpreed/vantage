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

export interface IssueEngagement {
  issueId: number;
  commDays: number;
  devDays: number;
  commDayCredits: number;  // With context switch factor applied
  devDayCredits: number;   // With context switch factor applied
}

export interface TeamMemberEngagement {
  username: string;
  totalActiveDays: number;
  commDays: number;
  devDays: number;
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
  
  // Get PR IDs linked to this issue
  const linkedPRIds = new Set(issue.linkedPRs.map(pr => pr.id));
  
  // Filter PR activities for this user on linked PRs
  const userIssuePRActivities = prActivities.filter(
    a => linkedPRIds.has(a.prId) && a.author === username
  );

  // Calculate raw unique days
  const commDays = countUniqueDays(userIssueComments.map(c => c.createdAt));
  const devDays = countUniqueDays(userIssuePRActivities.map(a => a.createdAt));

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

  return {
    issueId,
    commDays,
    devDays,
    commDayCredits,
    devDayCredits,
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
  const linkedPRIds = new Set<number>();
  for (const issue of issues) {
    for (const pr of issue.linkedPRs) {
      linkedPRIds.add(pr.id);
    }
  }

  // Filter data for this user
  const userComments = comments.filter(c => c.author === username);
  // Only count PR activities on PRs that are linked to tracked issues
  const userPRActivities = prActivities.filter(
    a => a.author === username && linkedPRIds.has(a.prId)
  );

  // Calculate raw unique days
  const commDates = userComments.map(c => c.createdAt);
  const devDates = userPRActivities.map(a => a.createdAt);
  
  const commDaysSet = new Set(commDates.map(toUtcDateKey));
  const devDaysSet = new Set(devDates.map(toUtcDateKey));
  const allDaysSet = new Set([...commDaysSet, ...devDaysSet]);

  const commDays = commDaysSet.size;
  const devDays = devDaysSet.size;
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
