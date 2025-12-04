import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import dotenv from "dotenv";

dotenv.config();

// Initialize REST API client
const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
});

// Initialize GraphQL client
const graphqlWithAuth = graphql.defaults({
    headers: {
        authorization: `token ${process.env.GITHUB_TOKEN}`,
    },
});

// In-memory cache per PR
const prCache = new Map();
const CACHE_TTL = 30 * 1000; // 30 seconds

// Get cache key for a PR
function getCacheKey(owner, repo, prNumber) {
    return `${owner}/${repo}#${prNumber}`;
}

// Get cached data if fresh enough
function getCachedData(owner, repo, prNumber) {
    const key = getCacheKey(owner, repo, prNumber);
    const cached = prCache.get(key);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`📦 Serving cached data for ${key} (age: ${Math.round((Date.now() - cached.timestamp) / 1000)}s)`);
        return cached.data;
    }
    
    return null;
}

// Store data in cache
function setCachedData(owner, repo, prNumber, data) {
    const key = getCacheKey(owner, repo, prNumber);
    prCache.set(key, {
        data: data,
        timestamp: Date.now(),
        lastUpdated: new Date().toISOString()
    });
    console.log(`💾 Cached data for ${key}`);
}

// Get last update timestamp for incremental fetch
function getLastUpdateTime(owner, repo, prNumber) {
    const key = getCacheKey(owner, repo, prNumber);
    const cached = prCache.get(key);
    return cached ? cached.lastUpdated : null;
}

// Fetch comments using REST API (cheaper)
async function fetchComments(owner, repo, prNumber, since = null) {
    try {
        const params = {
            owner,
            repo,
            pull_number: prNumber,
            per_page: 100
        };
        
        if (since) {
            params.since = since;
            console.log(`🔄 Fetching incremental updates since ${since}`);
        } else {
            console.log(`📥 Fetching full comment data`);
        }
        
        const response = await octokit.rest.pulls.listReviewComments(params);
        return response.data;
    } catch (error) {
        console.error('Error fetching comments:', error.message);
        throw error;
    }
}

// Fetch reactions for specific comments using GraphQL
async function fetchReactionsForComments(comments) {
    if (comments.length === 0) return {};
    
    const commentIds = comments.map(c => c.node_id);
    const reactions = {};
    
    // Batch fetch reactions (max 100 at a time to avoid rate limits)
    const batchSize = 50;
    for (let i = 0; i < commentIds.length; i += batchSize) {
        const batch = commentIds.slice(i, i + batchSize);
        
        const query = `
            query($ids: [ID!]!) {
                nodes(ids: $ids) {
                    ... on PullRequestReviewComment {
                        id
                        reactions(first: 50) {
                            nodes {
                                content
                                user {
                                    login
                                }
                            }
                        }
                    }
                }
            }
        `;
        
        try {
            const result = await graphqlWithAuth(query, { ids: batch });
            result.nodes.forEach((node, index) => {
                if (node && node.reactions) {
                    reactions[batch[index]] = node.reactions.nodes;
                }
            });
        } catch (error) {
            console.error('Error fetching reactions batch:', error.message);
        }
    }
    
    return reactions;
}

// Merge incremental updates with cached data
function mergeUpdates(cachedData, newComments, newReactions) {
    if (!cachedData) return null;
    
    const updatedComments = new Map();
    
    // Start with cached comments
    cachedData.comments.forEach(comment => {
        updatedComments.set(comment.id, comment);
    });
    
    // Update with new/changed comments
    newComments.forEach(comment => {
        const existingComment = updatedComments.get(comment.id);
        
        // Merge reactions if available
        if (newReactions[comment.node_id]) {
            comment.reactions = newReactions[comment.node_id];
        } else if (existingComment) {
            comment.reactions = existingComment.reactions;
        }
        
        updatedComments.set(comment.id, comment);
    });
    
    return {
        ...cachedData,
        comments: Array.from(updatedComments.values()),
        lastUpdated: new Date().toISOString()
    };
}

// Main function: Get PR data with incremental updates
export async function getPRDataIncremental(owner, repo, prNumber, forceRefresh = false) {
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
        const cached = getCachedData(owner, repo, prNumber);
        if (cached) {
            return cached;
        }
    }
    
    const lastUpdate = getLastUpdateTime(owner, repo, prNumber);
    
    if (lastUpdate && !forceRefresh) {
        // Incremental update
        console.log(`🔄 Performing incremental update for ${owner}/${repo}#${prNumber}`);
        
        const newComments = await fetchComments(owner, repo, prNumber, lastUpdate);
        
        if (newComments.length === 0) {
            console.log(`✅ No changes detected`);
            // Refresh cache timestamp
            const cached = prCache.get(getCacheKey(owner, repo, prNumber));
            if (cached) {
                cached.timestamp = Date.now();
                return cached.data;
            }
        }
        
        const newReactions = await fetchReactionsForComments(newComments);
        const cached = prCache.get(getCacheKey(owner, repo, prNumber));
        
        if (cached) {
            const merged = mergeUpdates(cached.data, newComments, newReactions);
            if (merged) {
                setCachedData(owner, repo, prNumber, merged);
                return merged;
            }
        }
    }
    
    // Full fetch (first time or force refresh)
    console.log(`📥 Performing full fetch for ${owner}/${repo}#${prNumber}`);
    return null; // Signal to use existing full fetch logic
}

// Clear cache for a specific PR
export function invalidateCache(owner, repo, prNumber) {
    const key = getCacheKey(owner, repo, prNumber);
    prCache.delete(key);
    console.log(`🗑️ Cache invalidated for ${key}`);
}

// Clear all cache
export function clearAllCache() {
    prCache.clear();
    console.log(`🗑️ All cache cleared`);
}

