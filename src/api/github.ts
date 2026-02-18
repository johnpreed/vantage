import { 
  upsertIssues, 
  upsertComments, 
  upsertPRActivity,
  updateSyncStatus,
  type Issue, 
  type Comment, 
  type Label, 
  type LinkedPR,
  type PRActivity
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

// Query to fetch PR details by node ID (works for PRs in any repo)
const PR_BY_ID_QUERY = `
query GetPRById($nodeId: ID!) {
  node(id: $nodeId) {
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
      updatedAt
      closedAt
      mergedAt
      repository {
        nameWithOwner
      }
      commits(first: 100) {
        nodes {
          commit {
            oid
            author {
              user {
                login
              }
            }
            committedDate
          }
        }
      }
      reviews(first: 50) {
        nodes {
          id
          author {
            login
          }
          state
          createdAt
        }
      }
      reviewThreads(first: 50) {
        nodes {
          comments(first: 50) {
            nodes {
              id
              author {
                login
              }
              createdAt
            }
          }
        }
      }
    }
  }
}
`;

interface PRByIdResponse {
  node: {
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
    repository: {
      nameWithOwner: string;
    };
    commits: {
      nodes: Array<{
        commit: {
          oid: string;
          author: {
            user: { login: string } | null;
          } | null;
          committedDate: string;
        };
      }>;
    };
    reviews: {
      nodes: Array<{
        id: string;
        author: { login: string } | null;
        state: string;
        createdAt: string;
      }>;
    };
    reviewThreads: {
      nodes: Array<{
        comments: {
          nodes: Array<{
            id: string;
            author: { login: string } | null;
            createdAt: string;
          }>;
        };
      }>;
    };
  } | null;
}

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
 * Get lookback date from configurable days
 */
function getLookbackDate(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
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
  lookbackDays: number,
  onProgress?: (message: string) => void,
  filter?: SearchFilter
): Promise<{ issues: Issue[]; comments: Comment[] }> {
  const { owner, repo } = parseRepo(repoString);
  const lookbackDate = getLookbackDate(lookbackDays);
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
  onProgress?.(`Fetching closed issues from ${repoString} (${lookbackDays}-day lookback)${labels ? ` with label: ${labels.join(', ')}` : ''}...`);
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
 * Fetch activity for linked PRs by their node IDs (works for PRs in any repo)
 */
export async function fetchLinkedPRActivities(
  token: string,
  linkedPRs: LinkedPR[],
  teamMembers: string[],
  onProgress?: (message: string) => void
): Promise<PRActivity[]> {
  const allActivities: PRActivity[] = [];
  const processedNodeIds = new Set<string>();

  onProgress?.(`Fetching activity for ${linkedPRs.length} linked PRs...`);

  let processed = 0;
  for (const linkedPR of linkedPRs) {
    // Skip if we've already processed this PR
    if (processedNodeIds.has(linkedPR.nodeId)) {
      continue;
    }
    processedNodeIds.add(linkedPR.nodeId);

    try {
      const data = await graphqlRequest<PRByIdResponse>(token, PR_BY_ID_QUERY, {
        nodeId: linkedPR.nodeId,
      });

      if (!data.node) {
        // PR might have been deleted or user doesn't have access
        continue;
      }

      const pr = data.node;
      const repository = pr.repository.nameWithOwner;

      // Extract commits by team members
      for (const commitNode of pr.commits.nodes) {
        const commitAuthor = commitNode.commit.author?.user?.login;
        if (commitAuthor && teamMembers.includes(commitAuthor)) {
          allActivities.push({
            id: `commit_${commitNode.commit.oid}`,
            prId: pr.databaseId,
            prNumber: pr.number,
            repository,
            type: 'commit',
            author: commitAuthor,
            createdAt: commitNode.commit.committedDate,
          });
        }
      }

      // Extract reviews by team members
      for (const review of pr.reviews.nodes) {
        const reviewAuthor = review.author?.login;
        if (reviewAuthor && teamMembers.includes(reviewAuthor)) {
          allActivities.push({
            id: `review_${review.id}`,
            prId: pr.databaseId,
            prNumber: pr.number,
            repository,
            type: 'review',
            author: reviewAuthor,
            createdAt: review.createdAt,
          });
        }
      }

      // Extract review comments by team members
      for (const thread of pr.reviewThreads.nodes) {
        for (const comment of thread.comments.nodes) {
          const commentAuthor = comment.author?.login;
          if (commentAuthor && teamMembers.includes(commentAuthor)) {
            allActivities.push({
              id: `review_comment_${comment.id}`,
              prId: pr.databaseId,
              prNumber: pr.number,
              repository,
              type: 'review_comment',
              author: commentAuthor,
              createdAt: comment.createdAt,
            });
          }
        }
      }
    } catch (error) {
      // Log but continue - some PRs may not be accessible
      console.warn(`Failed to fetch PR ${linkedPR.nodeId}:`, error);
    }

    processed++;
    if (processed % 10 === 0) {
      onProgress?.(`Fetched activity for ${processed}/${linkedPRs.length} linked PRs (${allActivities.length} activities)...`);
    }
  }

  onProgress?.(`Completed: ${allActivities.length} PR activities from ${processedNodeIds.size} linked PRs`);
  return allActivities;
}

/**
 * Full sync for all configured repositories
 */
export async function syncAllRepositories(
  token: string,
  repositories: string[],
  teamMembers: string[],
  lookbackDays: number,
  onProgress?: (message: string) => void,
  filter?: SearchFilter
): Promise<void> {
  await updateSyncStatus('global', { status: 'syncing', errorMessage: null });

  try {
    // Collect all issues, comments, and linked PRs across all repos
    const allIssues: Issue[] = [];
    const allComments: Comment[] = [];
    const allLinkedPRs: LinkedPR[] = [];

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
          lookbackDays,
          onProgress,
          filter
        );

        allIssues.push(...issues);
        allComments.push(...comments);

        // Collect linked PRs from these issues
        for (const issue of issues) {
          allLinkedPRs.push(...issue.linkedPRs);
        }

        await updateSyncStatus(repo, {
          status: 'idle',
          lastFullSync: new Date().toISOString(),
          issuesCount: issues.length,
          commentsCount: comments.length,
        });

        onProgress?.(`Completed issues sync for ${repo}: ${issues.length} issues, ${comments.length} comments`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await updateSyncStatus(repo, { status: 'error', errorMessage });
        onProgress?.(`Error syncing ${repo}: ${errorMessage}`);
      }
    }

    // Store issues and comments
    await upsertIssues(allIssues);
    await upsertComments(allComments);

    // Fetch activity for all linked PRs (handles cross-repo PRs)
    if (allLinkedPRs.length > 0) {
      const activities = await fetchLinkedPRActivities(token, allLinkedPRs, teamMembers, onProgress);
      await upsertPRActivity(activities);
      onProgress?.(`Stored ${activities.length} PR activities from ${allLinkedPRs.length} linked PRs`);
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

/**
 * Discussion category info for creating discussions
 */
export interface DiscussionCategory {
  id: string;
  name: string;
  slug: string;
}

const REPO_DISCUSSION_CATEGORIES_QUERY = `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
      discussionCategories(first: 20) {
        nodes {
          id
          name
          slug
        }
      }
    }
  }
`;

/**
 * Fetch repository ID and discussion categories
 */
export async function fetchDiscussionCategories(
  token: string,
  repo: string
): Promise<{ repositoryId: string; categories: DiscussionCategory[] }> {
  const [owner, name] = repo.split('/');
  
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: REPO_DISCUSSION_CATEGORIES_QUERY,
      variables: { owner, name },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }

  const repository = json.data.repository;
  if (!repository) {
    throw new Error(`Repository not found: ${repo}`);
  }

  return {
    repositoryId: repository.id,
    categories: repository.discussionCategories.nodes,
  };
}

const CREATE_DISCUSSION_MUTATION = `
  mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
    createDiscussion(input: {repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body}) {
      discussion {
        id
        url
        number
      }
    }
  }
`;

/**
 * Create a new discussion in a repository
 */
export async function createDiscussion(
  token: string,
  repositoryId: string,
  categoryId: string,
  title: string,
  body: string
): Promise<{ url: string; number: number }> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: CREATE_DISCUSSION_MUTATION,
      variables: { repositoryId, categoryId, title, body },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }

  const discussion = json.data.createDiscussion.discussion;
  return {
    url: discussion.url,
    number: discussion.number,
  };
}
