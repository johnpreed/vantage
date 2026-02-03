import { 
  upsertIssues, 
  upsertComments, 
  upsertPullRequests,
  updateSyncStatus,
  type Issue, 
  type Comment, 
  type Label, 
  type LinkedPR,
  type PullRequest 
} from '../db';

// ============================================================================
// Types
// ============================================================================

interface GraphQLResponse<T> {
  data: T;
  errors?: Array<{ message: string }>;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface IssueNode {
  id: string;
  databaseId: number;
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: { login: string } | null;
  assignees: {
    nodes: Array<{ login: string }>;
  };
  labels: {
    nodes: Array<{
      id: string;
      name: string;
      color: string;
      description: string | null;
    }>;
  };
  comments: {
    nodes: Array<{
      id: string;
      databaseId: number;
      author: { login: string } | null;
      body: string;
      createdAt: string;
      updatedAt: string;
    }>;
    pageInfo: PageInfo;
  };
  timelineItems: {
    nodes: Array<{
      __typename: string;
      subject?: {
        __typename: string;
        id: string;
        databaseId: number;
        number: number;
        title: string;
        state: string;
        url: string;
        author: { login: string } | null;
        createdAt: string;
        mergedAt: string | null;
      };
    }>;
  };
}

interface IssuesQueryResponse {
  repository: {
    issues: {
      nodes: IssueNode[];
      pageInfo: PageInfo;
      totalCount: number;
    };
  };
}

interface CommentsQueryResponse {
  node: {
    comments: {
      nodes: Array<{
        id: string;
        databaseId: number;
        author: { login: string } | null;
        body: string;
        createdAt: string;
        updatedAt: string;
      }>;
      pageInfo: PageInfo;
    };
  };
}

interface PRsQueryResponse {
  repository: {
    pullRequests: {
      nodes: Array<{
        id: string;
        databaseId: number;
        number: number;
        title: string;
        state: 'OPEN' | 'CLOSED' | 'MERGED';
        url: string;
        author: { login: string } | null;
        createdAt: string;
        updatedAt: string;
        closedAt: string | null;
        mergedAt: string | null;
      }>;
      pageInfo: PageInfo;
    };
  };
}

// ============================================================================
// GraphQL Queries
// ============================================================================

const ISSUES_QUERY = `
query GetIssues($owner: String!, $repo: String!, $states: [IssueState!], $after: String, $since: DateTime, $labels: [String!]) {
  repository(owner: $owner, name: $repo) {
    issues(
      first: 50
      after: $after
      states: $states
      filterBy: { since: $since, labels: $labels }
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        databaseId
        number
        title
        body
        state
        url
        createdAt
        updatedAt
        closedAt
        author {
          login
        }
        assignees(first: 10) {
          nodes {
            login
          }
        }
        labels(first: 20) {
          nodes {
            id
            name
            color
            description
          }
        }
        comments(first: 100) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            databaseId
            author {
              login
            }
            body
            createdAt
            updatedAt
          }
        }
        timelineItems(first: 20, itemTypes: [CROSS_REFERENCED_EVENT]) {
          nodes {
            __typename
            ... on CrossReferencedEvent {
              subject: source {
                __typename
                ... on PullRequest {
                  id
                  databaseId
                  number
                  title
                  state
                  url
                  author {
                    login
                  }
                  createdAt
                  mergedAt
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const COMMENTS_QUERY = `
query GetMoreComments($nodeId: ID!, $after: String!) {
  node(id: $nodeId) {
    ... on Issue {
      comments(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          databaseId
          author {
            login
          }
          body
          createdAt
          updatedAt
        }
      }
    }
  }
}
`;

const PRS_QUERY = `
query GetPullRequests($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(
      first: 50
      after: $after
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        databaseId
        number
        title
        state
        url
        author {
          login
        }
        createdAt
        updatedAt
        closedAt
        mergedAt
      }
    }
  }
}
`;

// ============================================================================
// API Client
// ============================================================================

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

async function graphqlRequest<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const result: GraphQLResponse<T> = await response.json();

  if (result.errors && result.errors.length > 0) {
    throw new Error(`GraphQL error: ${result.errors.map(e => e.message).join(', ')}`);
  }

  return result.data;
}

// ============================================================================
// Data Fetching Functions
// ============================================================================

/**
 * Parse repository string into owner and repo
 */
function parseRepo(repoString: string): { owner: string; repo: string } {
  const [owner, repo] = repoString.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repository format: ${repoString}. Expected: owner/repo`);
  }
  return { owner, repo };
}

/**
 * Fetch all comments for an issue using pagination
 */
async function fetchAllComments(
  token: string,
  issueNodeId: string,
  issueId: number,
  repository: string,
  initialComments: Comment[],
  pageInfo: PageInfo
): Promise<Comment[]> {
  const comments = [...initialComments];
  let cursor = pageInfo.endCursor;
  let hasMore = pageInfo.hasNextPage;

  while (hasMore && cursor) {
    const data = await graphqlRequest<CommentsQueryResponse>(token, COMMENTS_QUERY, {
      nodeId: issueNodeId,
      after: cursor,
    });

    const moreComments = data.node.comments.nodes.map(c => ({
      id: c.databaseId,
      nodeId: c.id,
      issueId,
      author: c.author?.login || 'ghost',
      body: c.body,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      repository,
    }));

    comments.push(...moreComments);
    hasMore = data.node.comments.pageInfo.hasNextPage;
    cursor = data.node.comments.pageInfo.endCursor;
  }

  return comments;
}

/**
 * Get the six-month lookback date
 */
function getSixMonthLookback(): Date {
  const date = new Date();
  date.setMonth(date.getMonth() - 6);
  return date;
}

/**
 * Transform API issue node to database Issue
 */
function transformIssue(
  node: IssueNode,
  repository: string,
  teamMembers: string[]
): { issue: Issue; comments: Comment[]; linkedPRs: LinkedPR[] } {
  const labels: Label[] = node.labels.nodes.map(l => ({
    id: l.id,
    name: l.name,
    color: l.color,
    description: l.description,
  }));

  const linkedPRs: LinkedPR[] = node.timelineItems.nodes
    .filter(item => item.__typename === 'CrossReferencedEvent' && item.subject?.__typename === 'PullRequest')
    .map(item => ({
      id: item.subject!.databaseId,
      nodeId: item.subject!.id,
      number: item.subject!.number,
      title: item.subject!.title,
      state: item.subject!.state as 'OPEN' | 'CLOSED' | 'MERGED',
      url: item.subject!.url,
      author: item.subject!.author?.login || 'ghost',
      createdAt: item.subject!.createdAt,
      mergedAt: item.subject!.mergedAt,
    }));

  const comments: Comment[] = node.comments.nodes.map(c => ({
    id: c.databaseId,
    nodeId: c.id,
    issueId: node.databaseId,
    author: c.author?.login || 'ghost',
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    repository,
  }));

  // Find last team comment
  const teamComments = comments.filter(c => teamMembers.includes(c.author));
  const lastTeamComment = teamComments.length > 0
    ? teamComments.reduce((latest, c) => 
        new Date(c.createdAt) > new Date(latest.createdAt) ? c : latest
      ).createdAt
    : null;

  const issue: Issue = {
    id: node.databaseId,
    nodeId: node.id,
    number: node.number,
    title: node.title,
    body: node.body,
    state: node.state,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt,
    repository,
    author: node.author?.login || 'ghost',
    assignees: node.assignees.nodes.map(a => a.login),
    labels,
    linkedPRs,
    lastTeamComment,
    lastSyncedAt: new Date().toISOString(),
  };

  return { issue, comments, linkedPRs };
}

/**
 * Parse search query into filter options
 */
export interface SearchFilter {
  labels?: string[];
  author?: string;
  assignee?: string;
  repo?: string;
}

export function parseSearchQuery(query: string): SearchFilter {
  const filter: SearchFilter = {};
  const trimmed = query.trim().toLowerCase();
  
  if (trimmed.startsWith('label:')) {
    filter.labels = [trimmed.slice(6).trim()];
  } else if (trimmed.startsWith('author:')) {
    filter.author = trimmed.slice(7).trim();
  } else if (trimmed.startsWith('assignee:')) {
    filter.assignee = trimmed.slice(9).trim();
  } else if (trimmed.startsWith('repo:')) {
    filter.repo = trimmed.slice(5).trim();
  }
  
  return filter;
}

/**
 * Fetch all issues (open + closed within lookback) for a repository
 */
export async function fetchRepositoryIssues(
  token: string,
  repoString: string,
  teamMembers: string[],
  onProgress?: (message: string) => void,
  filter?: SearchFilter
): Promise<{ issues: Issue[]; comments: Comment[] }> {
  const { owner, repo } = parseRepo(repoString);
  const lookbackDate = getSixMonthLookback();
  const allIssues: Issue[] = [];
  const allComments: Comment[] = [];
  
  // Get labels from filter for API query
  const labels = filter?.labels;

  // Fetch OPEN issues
  onProgress?.(`Fetching open issues from ${repoString}${labels ? ` with label: ${labels.join(', ')}` : ''}...`);
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const data: IssuesQueryResponse = await graphqlRequest<IssuesQueryResponse>(token, ISSUES_QUERY, {
      owner,
      repo,
      states: ['OPEN'],
      after: cursor,
      labels: labels || null,
    });

    for (const node of data.repository.issues.nodes) {
      const { issue, comments } = transformIssue(node, repoString, teamMembers);
      
      // Apply additional client-side filters (author, assignee)
      if (filter?.author && issue.author.toLowerCase() !== filter.author) continue;
      if (filter?.assignee && !issue.assignees.some(a => a.toLowerCase() === filter.assignee)) continue;
      
      allIssues.push(issue);

      // If there are more comments, fetch them
      if (node.comments.pageInfo.hasNextPage) {
        const moreComments = await fetchAllComments(
          token,
          node.id,
          node.databaseId,
          repoString,
          comments,
          node.comments.pageInfo
        );
        allComments.push(...moreComments);
      } else {
        allComments.push(...comments);
      }
    }

    hasMore = data.repository.issues.pageInfo.hasNextPage;
    cursor = data.repository.issues.pageInfo.endCursor;
    
    onProgress?.(`Fetched ${allIssues.length} open issues...`);
  }

  // Fetch CLOSED issues (with lookback)
  onProgress?.(`Fetching closed issues from ${repoString} (6-month lookback)${labels ? ` with label: ${labels.join(', ')}` : ''}...`);
  cursor = null;
  hasMore = true;

  while (hasMore) {
    const data: IssuesQueryResponse = await graphqlRequest<IssuesQueryResponse>(token, ISSUES_QUERY, {
      owner,
      repo,
      states: ['CLOSED'],
      after: cursor,
      since: lookbackDate.toISOString(),
      labels: labels || null,
    });

    for (const node of data.repository.issues.nodes) {
      // Double-check the closed date is within lookback
      if (node.closedAt && new Date(node.closedAt) < lookbackDate) {
        continue;
      }

      const { issue, comments } = transformIssue(node, repoString, teamMembers);
      
      // Apply additional client-side filters (author, assignee)
      if (filter?.author && issue.author.toLowerCase() !== filter.author) continue;
      if (filter?.assignee && !issue.assignees.some(a => a.toLowerCase() === filter.assignee)) continue;
      
      allIssues.push(issue);

      if (node.comments.pageInfo.hasNextPage) {
        const moreComments = await fetchAllComments(
          token,
          node.id,
          node.databaseId,
          repoString,
          comments,
          node.comments.pageInfo
        );
        allComments.push(...moreComments);
      } else {
        allComments.push(...comments);
      }
    }

    hasMore = data.repository.issues.pageInfo.hasNextPage;
    cursor = data.repository.issues.pageInfo.endCursor;

    onProgress?.(`Fetched ${allIssues.length} total issues...`);
  }

  return { issues: allIssues, comments: allComments };
}

/**
 * Fetch pull requests authored by team members
 */
export async function fetchTeamPullRequests(
  token: string,
  repoString: string,
  teamMembers: string[],
  onProgress?: (message: string) => void
): Promise<PullRequest[]> {
  const { owner, repo } = parseRepo(repoString);
  const lookbackDate = getSixMonthLookback();
  const allPRs: PullRequest[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  onProgress?.(`Fetching pull requests from ${repoString}...`);

  while (hasMore) {
    const data: PRsQueryResponse = await graphqlRequest<PRsQueryResponse>(token, PRS_QUERY, {
      owner,
      repo,
      after: cursor,
    });

    for (const pr of data.repository.pullRequests.nodes) {
      // Only include PRs within lookback period
      if (new Date(pr.createdAt) < lookbackDate) {
        hasMore = false;
        break;
      }

      // Only include PRs authored by team members
      const author = pr.author?.login || 'ghost';
      if (teamMembers.includes(author)) {
        allPRs.push({
          id: pr.databaseId,
          nodeId: pr.id,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          url: pr.url,
          repository: repoString,
          author,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          closedAt: pr.closedAt,
          mergedAt: pr.mergedAt,
          lastSyncedAt: new Date().toISOString(),
        });
      }
    }

    if (hasMore) {
      hasMore = data.repository.pullRequests.pageInfo.hasNextPage;
      cursor = data.repository.pullRequests.pageInfo.endCursor;
    }

    onProgress?.(`Fetched ${allPRs.length} team PRs...`);
  }

  return allPRs;
}

/**
 * Full sync for all configured repositories
 */
export async function syncAllRepositories(
  token: string,
  repositories: string[],
  teamMembers: string[],
  onProgress?: (message: string) => void,
  filter?: SearchFilter
): Promise<void> {
  await updateSyncStatus('global', { status: 'syncing', errorMessage: null });

  try {
    for (const repo of repositories) {
      // Skip if repo filter is set and doesn't match
      if (filter?.repo && !repo.toLowerCase().includes(filter.repo)) {
        continue;
      }
      
      onProgress?.(`Starting sync for ${repo}...`);
      await updateSyncStatus(repo, { status: 'syncing' });

      try {
        // Fetch issues and comments
        const { issues, comments } = await fetchRepositoryIssues(
          token,
          repo,
          teamMembers,
          onProgress,
          filter
        );

        // Fetch team PRs
        const prs = await fetchTeamPullRequests(token, repo, teamMembers, onProgress);

        // Store in IndexedDB
        await upsertIssues(issues);
        await upsertComments(comments);
        await upsertPullRequests(prs);

        await updateSyncStatus(repo, {
          status: 'idle',
          lastFullSync: new Date().toISOString(),
          issuesCount: issues.length,
          commentsCount: comments.length,
        });

        onProgress?.(`Completed sync for ${repo}: ${issues.length} issues, ${comments.length} comments, ${prs.length} PRs`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await updateSyncStatus(repo, { status: 'error', errorMessage });
        onProgress?.(`Error syncing ${repo}: ${errorMessage}`);
      }
    }

    await updateSyncStatus('global', {
      status: 'idle',
      lastFullSync: new Date().toISOString(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await updateSyncStatus('global', { status: 'error', errorMessage });
    throw error;
  }
}

/**
 * Verify PAT is valid
 */
export async function verifyToken(token: string): Promise<{ valid: boolean; login?: string; error?: string }> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return { valid: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const user = await response.json();
    return { valid: true, login: user.login };
  } catch (error) {
    return { 
      valid: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}
