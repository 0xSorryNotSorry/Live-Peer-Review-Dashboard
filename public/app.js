let refreshInterval = 20000; // Default 20 seconds
let refreshTimer = null;
let researchersConfig = { researchers: [], lsr: null };
let extraColumns = [];
let extraColumnData = {};
let latestRows = [];
let latestCommenters = [];
let isNightMode = false;
let currentRepoKey = null;
let allPRs = [];
let activePRIndex = 0;
let notifications = [];
let lastSeenComments = new Set();
let currentLSRAssignment = null; // Stores {groupNumber, primaryCommentUrl}

const EXTRA_COLUMNS_PREFIX = 'arm-extra-columns:';
const EXTRA_COLUMN_DATA_PREFIX = 'arm-extra-column-data:';
const SEEN_COMMENTS_PREFIX = 'arm-seen-comments:';
const RESOLUTION_STATES_PREFIX = 'arm-resolution-states:';
const LAST_SEEN_TIMESTAMP_PREFIX = 'arm-last-seen-timestamp:';

function escapeAttribute(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/"/g, '&quot;');
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTimestamp(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
}

// Load seen comments from localStorage
function loadSeenComments() {
    try {
        const key = getStorageKey(SEEN_COMMENTS_PREFIX);
        const data = localStorage.getItem(key);
        return data ? new Set(JSON.parse(data)) : new Set();
    } catch (error) {
        return new Set();
    }
}

// Load first-seen timestamps for notifications
function loadFirstSeenTimestamps() {
    try {
        const key = getStorageKey(LAST_SEEN_TIMESTAMP_PREFIX);
        const data = localStorage.getItem(key);
        return data ? new Map(JSON.parse(data)) : new Map();
    } catch (error) {
        return new Map();
    }
}

// Save first-seen timestamps
function saveFirstSeenTimestamps(timestampsMap) {
    try {
        const key = getStorageKey(LAST_SEEN_TIMESTAMP_PREFIX);
        localStorage.setItem(key, JSON.stringify(Array.from(timestampsMap.entries())));
    } catch (error) {
        console.error('Failed to save timestamps:', error);
    }
}

// Save seen comments to localStorage
function saveSeenComments() {
    try {
        const key = getStorageKey(SEEN_COMMENTS_PREFIX);
        localStorage.setItem(key, JSON.stringify(Array.from(lastSeenComments)));
    } catch (error) {
        console.error('Failed to save seen comments:', error);
    }
}

// Load resolution states from localStorage
function loadResolutionStates() {
    try {
        const key = getStorageKey(RESOLUTION_STATES_PREFIX);
        const data = localStorage.getItem(key);
        if (data) {
            const obj = JSON.parse(data);
            return new Map(Object.entries(obj));
        }
    } catch (error) {
        console.error('Failed to load resolution states:', error);
    }
    return new Map();
}

// Save resolution states to localStorage
function saveResolutionStates(statesMap) {
    try {
        const key = getStorageKey(RESOLUTION_STATES_PREFIX);
        const obj = Object.fromEntries(statesMap);
        localStorage.setItem(key, JSON.stringify(obj));
    } catch (error) {
        console.error('Failed to save resolution states:', error);
    }
}

// Check for new comments and update notifications
function checkForNewComments(rows) {
    lastSeenComments = loadSeenComments();
    const previousResolutionStates = loadResolutionStates();
    const firstSeenTimestamps = loadFirstSeenTimestamps();
    const currentResolutionStates = new Map();
    notifications = [];
    
    rows.forEach(row => {
        // Track current resolution state
        currentResolutionStates.set(row.commentUrl, row.isResolved);
        
        // Check for resolution changes
        const wasResolved = previousResolutionStates.get(row.commentUrl);
        if (row.isResolved && wasResolved === false) {
            // Thread was just resolved - find who resolved it
            const resolutionId = `${row.commentUrl}-resolved`;
            const isRead = lastSeenComments.has(resolutionId);
            
            // Try to find who resolved it from thread comments
            let resolver = null;
            if (row.threadReplies && row.threadReplies.length > 0) {
                // Look for "marked this conversation as resolved" message
                const resolutionComment = row.threadReplies.find(r => {
                    const hasMessage = r.body && (
                        r.body.includes('marked this conversation as resolved') ||
                        r.body.includes('resolved this conversation')
                    );
                    if (hasMessage) {
                        console.log('Found resolution message:', r.body, 'by', r.author);
                    }
                    return hasMessage;
                });
                if (resolutionComment) {
                    resolver = resolutionComment.author;
                } else {
                    console.log('No resolution message found in', row.threadReplies.length, 'replies for', row.commentUrl);
                }
            }
            
            notifications.push({
                id: resolutionId,
                type: 'resolution',
                threadUrl: row.commentUrl,
                issueNumber: row.issueNumber,
                issueTitle: row.Comment.text,
                resolver: resolver,
                createdAt: new Date().toISOString(), // Use NOW since we just detected the resolution
                read: isRead
            });
        }
        
        // Check for new replies in thread
        if (row.threadReplies && row.threadReplies.length > 0) {
            row.threadReplies.forEach(reply => {
                const commentId = `${row.commentUrl}-reply-${reply.id}`;
                const isRead = lastSeenComments.has(commentId);
                
                notifications.push({
                    id: commentId,
                    type: 'comment',
                    threadUrl: row.commentUrl,
                    author: reply.author,
                    body: reply.body,
                    createdAt: reply.createdAt,
                    issueNumber: row.issueNumber,
                    issueTitle: row.Comment.text,
                    reactions: reply.reactions || [],
                    read: isRead
                });
            });
        }
        
        // Check for new reactions on the main comment
        if (row.reactions) {
            Object.keys(row.reactions).forEach(user => {
                if (row.reactions[user] && user !== row.proposer) {
                    const reactionId = `${row.commentUrl}-reaction-${user}`;
                    const isRead = lastSeenComments.has(reactionId);
                    
                    // Get the emoji for this user
                    const emoji = row[user]; // This contains the emoji (👍, 👎, etc.)
                    
                    if (emoji && emoji !== 'Proposer') {
                        // Use first-seen timestamp for consistent ordering
                        if (!firstSeenTimestamps.has(reactionId)) {
                            firstSeenTimestamps.set(reactionId, new Date().toISOString());
                        }
                        
                        notifications.push({
                            id: reactionId,
                            type: 'reaction',
                            threadUrl: row.commentUrl,
                            author: user,
                            emoji: emoji,
                            issueNumber: row.issueNumber,
                            issueTitle: row.Comment.text,
                            createdAt: firstSeenTimestamps.get(reactionId),
                            read: isRead
                        });
                    }
                }
            });
        }
    });
    
    // Save current resolution states and timestamps for next comparison
    saveResolutionStates(currentResolutionStates);
    saveFirstSeenTimestamps(firstSeenTimestamps);
    
    // Sort by most recent first (newest at top)
    notifications.sort((a, b) => {
        const dateA = new Date(a.createdAt).getTime();
        const dateB = new Date(b.createdAt).getTime();
        return dateB - dateA; // Descending order (newest first)
    });
    
    updateNotificationBadge();
}

// Update notification badge count (only unread)
function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    const unreadCount = notifications.filter(n => !n.read).length;
    
    if (unreadCount > 0) {
        badge.textContent = unreadCount;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

// Render notification panel
function renderNotificationPanel() {
    const list = document.getElementById('notificationList');
    
    if (notifications.length === 0) {
        list.innerHTML = '<p class="no-notifications">No new comments</p>';
        return;
    }
    
    let html = '';
    notifications.forEach(notif => {
        const readClass = notif.read ? 'read' : 'unread';
        html += `<div class="notification-item ${readClass}" data-thread-url="${notif.threadUrl}" data-notif-id="${notif.id}">`;
        
        if (notif.type === 'resolution') {
            // Resolution notification
            const resolverText = notif.resolver ? ` by ${notif.resolver}` : '';
            html += `<div class="notification-author">✅ Thread #${notif.issueNumber} was resolved${resolverText}</div>`;
            html += `<div class="notification-preview">`;
            html += `<a href="${notif.threadUrl}" target="_blank" class="notif-link">${escapeHtml(notif.issueTitle.substring(0, 80))}${notif.issueTitle.length > 80 ? '...' : ''}</a>`;
            html += `</div>`;
        } else if (notif.type === 'reaction') {
            // Reaction notification
            html += `<div class="notification-author">${notif.author} reacted with ${notif.emoji}</div>`;
            html += `<div class="notification-preview">`;
            html += `<a href="${notif.threadUrl}" target="_blank" class="notif-link">${escapeHtml(notif.issueTitle.substring(0, 80))}${notif.issueTitle.length > 80 ? '...' : ''}</a>`;
            html += `</div>`;
        } else {
            // Comment notification
            html += `<div class="notification-author">${notif.author} commented on #${notif.issueNumber}</div>`;
            html += `<div class="notification-preview">${escapeHtml(notif.body.substring(0, 100))}${notif.body.length > 100 ? '...' : ''}</div>`;
            
            // Show reactions if any
            if (notif.reactions && notif.reactions.length > 0) {
                html += `<div class="notification-reactions">`;
                notif.reactions.forEach(r => {
                    html += `<span class="reaction-mini">${r.content}</span>`;
                });
                html += `</div>`;
            }
        }
        
        html += `<div class="comment-time">${formatTimestamp(notif.createdAt)}</div>`;
        html += `</div>`;
    });
    
    list.innerHTML = html;
    
    // Add click handlers
    document.querySelectorAll('.notification-item').forEach(item => {
        item.addEventListener('click', function(e) {
            // Don't trigger if clicking the link
            if (e.target.classList.contains('notif-link')) {
                return;
            }
            
            const threadUrl = this.dataset.threadUrl;
            const notifId = this.dataset.notifId;
            scrollToComment(threadUrl);
            markSingleNotificationAsRead(notifId);
        });
    });
}

// Scroll to comment and expand thread
function scrollToComment(threadUrl) {
    const threadId = `thread-${encodeURIComponent(threadUrl)}`;
    let row = null;
    
    // Try to find the thread view first
    const threadView = document.getElementById(threadId);
    if (threadView) {
        row = threadView.closest('tr');
        
        // Expand thread if collapsed
        if (threadView.style.display === 'none') {
            const button = document.querySelector(`[data-thread-id="${threadId}"]`);
            if (button) {
                button.click();
            }
        }
    } else {
        // No thread view (no replies) - find row by comment URL
        // Search all comment links for matching URL
        const commentLinks = document.querySelectorAll('a[href="' + threadUrl + '"]');
        if (commentLinks.length > 0) {
            row = commentLinks[0].closest('tr');
        }
    }
    
    if (row) {
        // Scroll to row
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Highlight row briefly
        row.style.background = '#fff3cd';
        setTimeout(() => {
            row.style.background = '';
        }, 2000);
    }
    
    // Close notification panel
    document.getElementById('notificationPanel').style.display = 'none';
}

// Mark a single notification as read
function markSingleNotificationAsRead(notifId) {
    const notif = notifications.find(n => n.id === notifId);
    if (notif && !notif.read) {
        notif.read = true;
        lastSeenComments.add(notif.id);
        saveSeenComments();
        updateNotificationBadge();
        renderNotificationPanel();
    }
}

// Mark all notifications for a thread as read (but keep in list)
function markNotificationAsRead(threadUrl) {
    let badgeCountChanged = false;
    
    notifications.forEach(n => {
        if (n.threadUrl === threadUrl && !n.read) {
            n.read = true;
            lastSeenComments.add(n.id);
            badgeCountChanged = true;
        }
    });
    
    if (badgeCountChanged) {
        saveSeenComments();
        updateNotificationBadge();
        renderNotificationPanel();
    }
}

// Mark all notifications as read
function markAllNotificationsRead() {
    notifications.forEach(n => {
        n.read = true;
        lastSeenComments.add(n.id);
    });
    
    saveSeenComments();
    updateNotificationBadge();
    renderNotificationPanel();
}

// Mark all notifications as unread
function markAllNotificationsUnread() {
    notifications.forEach(n => {
        n.read = false;
        lastSeenComments.delete(n.id);
    });
    
    saveSeenComments();
    updateNotificationBadge();
    renderNotificationPanel();
}

function getRowKey(row) {
    return row.commentUrl || row.Comment?.hyperlink || row.Comment?.id || row.Comment?.text || '';
}

function getDefaultColumnName(index) {
    return `Column ${index + 1}`;
}

function getRepositoryKey(repository) {
    if (!repository || !repository.owner || !repository.repo || !repository.pullRequestNumber) {
        return 'default';
    }
    return `${repository.owner}/${repository.repo}#${repository.pullRequestNumber}`;
}

function getStorageKey(prefix) {
    const key = currentRepoKey || 'default';
    return `${prefix}${key}`;
}

function loadExtraColumnState() {
    try {
        const columnsRaw = localStorage.getItem(getStorageKey(EXTRA_COLUMNS_PREFIX));
        const dataRaw = localStorage.getItem(getStorageKey(EXTRA_COLUMN_DATA_PREFIX));
        const parsedColumns = columnsRaw ? JSON.parse(columnsRaw) : [];
        const parsedData = dataRaw ? JSON.parse(dataRaw) : {};

        if (Array.isArray(parsedColumns)) {
            extraColumns = parsedColumns.map((col, idx) => {
                const id = col?.id || `custom-${Date.now()}-${idx}`;
                const name = col?.name || getDefaultColumnName(idx);
                return { id, name };
            });
        } else {
            extraColumns = [];
        }

        if (parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)) {
            extraColumnData = {};
            extraColumns.forEach(column => {
                extraColumnData[column.id] = parsedData[column.id] && typeof parsedData[column.id] === 'object'
                    ? parsedData[column.id]
                    : {};
            });
        } else {
            extraColumnData = {};
            extraColumns.forEach(column => {
                extraColumnData[column.id] = {};
            });
        }
    } catch (error) {
        console.warn('Failed to load extra column state:', error);
        extraColumns = [];
        extraColumnData = {};
    }
}

function persistExtraColumnState() {
    try {
        localStorage.setItem(getStorageKey(EXTRA_COLUMNS_PREFIX), JSON.stringify(extraColumns));
        localStorage.setItem(getStorageKey(EXTRA_COLUMN_DATA_PREFIX), JSON.stringify(extraColumnData));
    } catch (error) {
        console.warn('Failed to persist extra column state:', error);
    }
}

function setRepositoryContext(repository) {
    const repoKey = getRepositoryKey(repository);
    if (repoKey !== currentRepoKey) {
        currentRepoKey = repoKey;
        loadExtraColumnState();
        updateColumnControls();
        return true;
    }
    return false;
}

function updateColumnControls() {
    const removeBtn = document.getElementById('removeColumn');
    if (removeBtn) {
        removeBtn.style.display = extraColumns.length > 0 ? 'inline-flex' : 'none';
    }
}

function renderCurrentTable() {
    renderCommentsTable(latestRows, latestCommenters);
}

function addExtraColumn() {
    const columnIndex = extraColumns.length;
    const columnId = `custom-${Date.now()}`;
    extraColumns.push({ id: columnId, name: getDefaultColumnName(columnIndex) });
    extraColumnData[columnId] = {};
    updateColumnControls();
    persistExtraColumnState();
    renderCurrentTable();
}

function removeExtraColumn() {
    const removed = extraColumns.pop();
    if (removed) {
        delete extraColumnData[removed.id];
        updateColumnControls();
        persistExtraColumnState();
        renderCurrentTable();
    }
}

function applyNightModeState() {
    document.body.classList.toggle('dark-mode', isNightMode);
    const nightBtn = document.getElementById('toggleNightMode');
    if (nightBtn) {
        nightBtn.textContent = isNightMode ? '☀️ Day Mode' : '🌙 Night Mode';
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    setupFloatingButtons();
    loadAllPRs();
    // Don't start auto-refresh by default (manual mode is selected)
});

// Setup floating refresh button (draggable) and go-to-top button
function setupFloatingButtons() {
    const floatingRefresh = document.getElementById('floatingRefresh');
    const goToTop = document.getElementById('goToTop');
    
    if (!floatingRefresh || !goToTop) return;
    
    // Floating refresh button - draggable
    let isDragging = false;
    let hasMoved = false;
    let currentX = 0;
    let currentY = 0;
    let initialX;
    let initialY;
    let xOffset = 0;
    let yOffset = 0;
    
    floatingRefresh.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    
    function dragStart(e) {
        if (e.target === floatingRefresh || floatingRefresh.contains(e.target)) {
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;
            isDragging = true;
            hasMoved = false;
            floatingRefresh.classList.add('dragging');
        }
    }
    
    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            
            // Mark as moved if dragged more than 5px
            if (Math.abs(currentX - xOffset) > 5 || Math.abs(currentY - yOffset) > 5) {
                hasMoved = true;
            }
            
            xOffset = currentX;
            yOffset = currentY;
            
            setTranslate(currentX, currentY, floatingRefresh);
        }
    }
    
    function dragEnd(e) {
        if (isDragging) {
            isDragging = false;
            floatingRefresh.classList.remove('dragging');
            
            // If it was a click (not a drag), trigger refresh
            if (!hasMoved) {
                const forceRefresh = e.shiftKey;
                loadData(forceRefresh);
                
                const iconEl = floatingRefresh.querySelector('.refresh-icon');
                if (iconEl) {
                    if (forceRefresh) {
                        iconEl.textContent = '⚡';
                        setTimeout(() => {
                            iconEl.textContent = '🔄';
                        }, 1000);
                    } else {
                        // Show spinning animation for regular refresh
                        iconEl.style.animation = 'spin 1s linear';
                        setTimeout(() => {
                            iconEl.style.animation = '';
                        }, 1000);
                    }
                }
            }
        }
    }
    
    function setTranslate(xPos, yPos, el) {
        el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
    }
    
    // Go to top button - show/hide on scroll
    window.addEventListener('scroll', () => {
        if (window.pageYOffset > 300) {
            goToTop.classList.add('visible');
        } else {
            goToTop.classList.remove('visible');
        }
    });
    
    goToTop.addEventListener('click', () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    });
    
    // Notification button and panel
    const notificationBtn = document.getElementById('notificationBtn');
    const notificationPanel = document.getElementById('notificationPanel');
    const closePanel = notificationPanel.querySelector('.close-panel');
    
    if (notificationBtn) {
        notificationBtn.addEventListener('click', () => {
            const isVisible = notificationPanel.style.display === 'block';
            notificationPanel.style.display = isVisible ? 'none' : 'block';
            if (!isVisible) {
                renderNotificationPanel();
            }
        });
    }
    
    if (closePanel) {
        closePanel.addEventListener('click', () => {
            notificationPanel.style.display = 'none';
        });
    }
    
    // Mark all read button
    const markAllReadBtn = document.getElementById('markAllRead');
    if (markAllReadBtn) {
        markAllReadBtn.addEventListener('click', () => {
            markAllNotificationsRead();
        });
    }
    
    // Mark all unread button
    const markAllUnreadBtn = document.getElementById('markAllUnread');
    if (markAllUnreadBtn) {
        markAllUnreadBtn.addEventListener('click', () => {
            markAllNotificationsUnread();
        });
    }
    
    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
        if (notificationPanel.style.display === 'block' && 
            !notificationPanel.contains(e.target) && 
            e.target !== notificationBtn) {
            notificationPanel.style.display = 'none';
        }
    });
    
    // LSR Assignment Modal
    const lsrModal = document.getElementById('lsrAssignmentModal');
    if (lsrModal) {
        const closeBtn = lsrModal.querySelector('.close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                lsrModal.style.display = 'none';
            });
        }
        
        const submitBtn = document.getElementById('submitLSRAssignment');
        if (submitBtn) {
            submitBtn.addEventListener('click', submitLSRAssignment);
        }
        
        const cancelBtn = document.getElementById('cancelLSRAssignment');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                lsrModal.style.display = 'none';
            });
        }
    }
}

// Load all PRs and render tabs
async function loadAllPRs() {
    try {
        const response = await fetch('/api/prs');
        const data = await response.json();
        allPRs = data.repositories || [];
        
        if (allPRs.length > 0) {
            // Load current config into form fields
            const activeRepo = allPRs[activePRIndex];
            if (activeRepo) {
                document.getElementById('prOwner').value = activeRepo.owner;
                document.getElementById('prRepo').value = activeRepo.repo;
                document.getElementById('prNumber').value = activeRepo.pullRequestNumber;
            }
            
            renderPRTabs();
            loadData();
        } else {
            // No PRs configured, show initial config UI
            document.getElementById('loading').style.display = 'none';
        }
    } catch (error) {
        console.error('Error loading PRs:', error);
        document.getElementById('loading').style.display = 'none';
    }
}

// Render PR tabs
function renderPRTabs() {
    if (allPRs.length === 0) {
        document.getElementById('prTabsContainer').style.display = 'none';
        return;
    }
    
    document.getElementById('prTabsContainer').style.display = 'flex';
    const tabsContainer = document.getElementById('prTabs');
    
    let html = '';
    allPRs.forEach((pr, index) => {
        const isActive = index === activePRIndex;
        // Use custom label if set, otherwise use short format: repo#PR
        const label = pr.customLabel || `${pr.repo}#${pr.pullRequestNumber}`;
        html += `<div class="pr-tab ${isActive ? 'active' : ''}" data-index="${index}" title="Double-click to edit label\n${pr.owner}/${pr.repo}#${pr.pullRequestNumber}">${label}</div>`;
    });
    
    tabsContainer.innerHTML = html;
    
    // Add click handlers
    document.querySelectorAll('.pr-tab').forEach(tab => {
        tab.addEventListener('click', function(e) {
            const index = parseInt(this.dataset.index);
            switchToPR(index);
        });
        
        // Add double-click to edit
        tab.addEventListener('dblclick', function(e) {
            e.stopPropagation();
            const index = parseInt(this.dataset.index);
            editTabLabel(index, this);
        });
    });
    
    // Auto-scroll to active tab
    scrollToActiveTab();
}

// Scroll active tab into view
function scrollToActiveTab() {
    const activeTab = document.querySelector('.pr-tab.active');
    if (activeTab) {
        activeTab.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'center'
        });
    }
}

// Edit tab label
function editTabLabel(index, tabElement) {
    const pr = allPRs[index];
    const currentLabel = pr.customLabel || `${pr.repo}#${pr.pullRequestNumber}`;
    
    const newLabel = prompt('Enter custom tab label:', currentLabel);
    
    if (newLabel !== null && newLabel.trim() !== '') {
        pr.customLabel = newLabel.trim();
        
        // Save to config
        saveAllPRs();
        
        // Re-render tabs
        renderPRTabs();
    }
}

// Save all PRs to server
async function saveAllPRs() {
    try {
        const response = await fetch('/api/prs/update-all', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repositories: allPRs })
        });
        
        const data = await response.json();
        if (!data.success) {
            console.error('Failed to save PR labels');
        }
    } catch (error) {
        console.error('Error saving PR labels:', error);
    }
}

// Switch to a different PR
async function switchToPR(index) {
    if (index === activePRIndex) return;
    
    activePRIndex = index;
    
    // Update form fields with new active PR
    const activeRepo = allPRs[activePRIndex];
    if (activeRepo) {
        document.getElementById('prOwner').value = activeRepo.owner;
        document.getElementById('prRepo').value = activeRepo.repo;
        document.getElementById('prNumber').value = activeRepo.pullRequestNumber;
        
        // Load researchers for this PR
        try {
            const response = await fetch(`/api/researchers?owner=${activeRepo.owner}&repo=${activeRepo.repo}&prNumber=${activeRepo.pullRequestNumber}`);
            const config = await response.json();
            researchersConfig = config;
        } catch (error) {
            console.error('Error loading researchers:', error);
            researchersConfig = { researchers: [], lsr: null };
        }
    }
    
    renderPRTabs();
    loadData();
}

// Open PR management modal
function openPRManagementModal() {
    const modal = document.getElementById('prManagementModal');
    modal.style.display = 'block';
    renderPRList();
}

// Render PR list in modal
function renderPRList() {
    const container = document.getElementById('prList');
    
    if (allPRs.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: #666;">No PRs configured yet. Add one below.</p>';
        return;
    }
    
    let html = '';
    allPRs.forEach((pr, index) => {
        html += `
            <div class="pr-item">
                <div class="pr-item-info">
                    <strong>${pr.owner}/${pr.repo} - PR #${pr.pullRequestNumber}</strong>
                    <small style="color: #666;">https://github.com/${pr.owner}/${pr.repo}/pull/${pr.pullRequestNumber}</small>
                </div>
                <div class="pr-item-actions">
                    <button class="btn-remove-pr" onclick="removePR(${index})">🗑️ Remove</button>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

// Add new PR from URL
async function addNewPRFromUrl() {
    const url = document.getElementById('newPrUrl').value.trim();
    
    if (!url) {
        alert('Please paste a GitHub PR URL');
        return;
    }
    
    const parsed = parsePRUrl(url);
    if (!parsed) {
        alert('Invalid GitHub PR URL. Format: https://github.com/owner/repo/pull/123');
        return;
    }
    
    try {
        const response = await fetch('/api/prs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
        });
        
        const data = await response.json();
        
        if (data.success) {
            allPRs = data.repositories;
            renderPRList();
            renderPRTabs();
            
            // Clear input
            document.getElementById('newPrUrl').value = '';
            
            alert('✅ PR added successfully!');
            
            // Switch to the newly added PR
            activePRIndex = allPRs.length - 1;
            renderPRTabs();
            
            // Close modal and load data
            document.getElementById('prManagementModal').style.display = 'none';
            loadData();
        } else {
            alert('❌ ' + (data.error || 'Failed to add PR'));
        }
    } catch (error) {
        console.error('Error adding PR:', error);
        alert('❌ Error adding PR');
    }
}

// Add new PR
async function addNewPR() {
    const owner = document.getElementById('newPrOwner').value.trim();
    const repo = document.getElementById('newPrRepo').value.trim();
    const pullRequestNumber = parseInt(document.getElementById('newPrNumber').value);
    
    if (!owner || !repo || !pullRequestNumber) {
        alert('Please fill in all fields');
        return;
    }
    
    try {
        const response = await fetch('/api/prs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ owner, repo, pullRequestNumber })
        });
        
        const data = await response.json();
        
        if (data.success) {
            allPRs = data.repositories;
            renderPRList();
            renderPRTabs();
            
            // Clear inputs
            document.getElementById('newPrOwner').value = '';
            document.getElementById('newPrRepo').value = '';
            document.getElementById('newPrNumber').value = '';
            
            alert('✅ PR added successfully!');
            
            // Switch to the newly added PR
            activePRIndex = allPRs.length - 1;
            renderPRTabs();
            
            // Close modal and load data
            document.getElementById('prManagementModal').style.display = 'none';
            loadData();
        } else {
            alert('❌ ' + (data.error || 'Failed to add PR'));
        }
    } catch (error) {
        console.error('Error adding PR:', error);
        alert('❌ Error adding PR');
    }
}

// Remove PR
async function removePR(index) {
    if (!confirm('Are you sure you want to remove this PR?')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/prs/${index}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            allPRs = data.repositories;
            renderPRList();
            
            // If we removed the active PR, switch to first PR
            if (index === activePRIndex) {
                activePRIndex = 0;
                if (allPRs.length > 0) {
                    renderPRTabs();
                    loadData();
                } else {
                    // No PRs left
                    document.getElementById('prTabsContainer').style.display = 'none';
                    document.getElementById('content').style.display = 'none';
                }
            } else if (index < activePRIndex) {
                // Adjust active index if we removed a PR before it
                activePRIndex--;
            }
            
            renderPRTabs();
            alert('✅ PR removed successfully!');
        } else {
            alert('❌ ' + (data.error || 'Failed to remove PR'));
        }
    } catch (error) {
        console.error('Error removing PR:', error);
        alert('❌ Error removing PR');
    }
}

function setupEventListeners() {
    // Refresh interval change
    document.getElementById('refreshInterval').addEventListener('change', (e) => {
        const value = e.target.value;
        if (value === 'manual') {
            stopAutoRefresh();
        } else {
            refreshInterval = parseInt(value) * 1000;
            startAutoRefresh();
        }
    });

    // Manual refresh
    document.getElementById('manualRefresh').addEventListener('click', () => {
        loadData();
    });
    
    // Force refresh (bypass cache)
    document.getElementById('forceRefresh').addEventListener('click', () => {
        loadData(true);
    });

    // Generate PDF
    document.getElementById('generatePDF').addEventListener('click', async () => {
        const btn = document.getElementById('generatePDF');
        btn.disabled = true;
        btn.textContent = '⏳ Generating...';
        
        try {
            const response = await fetch('/api/generate-pdf', { method: 'POST' });
            
            if (response.ok) {
                // Get the filename from the response headers or use default
                const contentDisposition = response.headers.get('Content-Disposition');
                let filename = 'Audit_Review.pdf';
                if (contentDisposition) {
                    const match = contentDisposition.match(/filename="(.+)"/);
                    if (match) filename = match[1];
                }
                
                // Download the PDF
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                
                alert('✅ PDF downloaded successfully!');
            } else {
                alert('❌ Error generating PDF');
            }
        } catch (error) {
            alert('❌ Error: ' + error.message);
        } finally {
            btn.disabled = false;
            btn.textContent = '📄 Generate PDF';
        }
    });

    // Manage researchers modal
    const modal = document.getElementById('researchersModal');
    const btn = document.getElementById('manageResearchers');
    const span = document.getElementsByClassName('close')[0];

    btn.onclick = () => {
        loadResearchersModal();
        modal.style.display = 'block';
    };

    span.onclick = () => {
        modal.style.display = 'none';
    };

    window.onclick = (event) => {
        if (event.target == modal) {
            modal.style.display = 'none';
        }
    };

    // Add researcher
    document.getElementById('addResearcher').addEventListener('click', addResearcher);
    
    // Sync PR
    document.getElementById('syncPR').addEventListener('click', syncPR);
    
    // Sync PR from URL
    document.getElementById('syncPRUrl').addEventListener('click', syncPRFromUrl);

    const addColumnBtn = document.getElementById('addColumn');
    if (addColumnBtn) {
        addColumnBtn.addEventListener('click', addExtraColumn);
    }

    const removeColumnBtn = document.getElementById('removeColumn');
    if (removeColumnBtn) {
        removeColumnBtn.addEventListener('click', removeExtraColumn);
    }

    updateColumnControls();

    const nightModeBtn = document.getElementById('toggleNightMode');
    if (nightModeBtn) {
        const stored = localStorage.getItem('arm-night-mode');
        if (stored === 'true') {
            isNightMode = true;
            applyNightModeState();
        }
        nightModeBtn.addEventListener('click', () => {
            isNightMode = !isNightMode;
            applyNightModeState();
            localStorage.setItem('arm-night-mode', isNightMode ? 'true' : 'false');
        });
    }
    
    // PR Management Modal
    const managePRsBtn = document.getElementById('managePRs');
    if (managePRsBtn) {
        managePRsBtn.addEventListener('click', openPRManagementModal);
    }
    
    const addPRBtn = document.getElementById('addPR');
    if (addPRBtn) {
        addPRBtn.addEventListener('click', addNewPR);
    }
    
    const addPRFromUrlBtn = document.getElementById('addPRFromUrl');
    if (addPRFromUrlBtn) {
        addPRFromUrlBtn.addEventListener('click', addNewPRFromUrl);
    }
    
    // Close PR management modal
    const prModal = document.getElementById('prManagementModal');
    if (prModal) {
        const closeBtn = prModal.querySelector('.close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                prModal.style.display = 'none';
            });
        }
        
        window.addEventListener('click', (e) => {
            if (e.target === prModal) {
                prModal.style.display = 'none';
            }
        });
    }
}

function parsePRUrl(url) {
    // Parse GitHub PR URL: https://github.com/owner/repo/pull/123
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
    if (match) {
        return {
            owner: match[1],
            repo: match[2],
            pullRequestNumber: parseInt(match[3])
        };
    }
    return null;
}

async function syncPRFromUrl() {
    const url = document.getElementById('prUrl').value.trim();
    
    if (!url) {
        alert('Please paste a GitHub PR URL');
        return;
    }
    
    const parsed = parsePRUrl(url);
    if (!parsed) {
        alert('Invalid GitHub PR URL. Format: https://github.com/owner/repo/pull/123');
        return;
    }
    
    // Update the manual input fields
    document.getElementById('prOwner').value = parsed.owner;
    document.getElementById('prRepo').value = parsed.repo;
    document.getElementById('prNumber').value = parsed.pullRequestNumber;
    
    // Sync the PR
    const btn = document.getElementById('syncPRUrl');
    btn.disabled = true;
    btn.textContent = '⏳ Syncing...';
    
    try {
        const response = await fetch('/api/update-pr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert('✅ PR updated! Refreshing data...');
            await loadData();
        } else {
            alert('❌ Error updating PR');
        }
    } catch (error) {
        alert('❌ Error: ' + error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Sync from URL';
    }
}

// Removed - config is now loaded from allPRs array

async function syncPR() {
    const owner = document.getElementById('prOwner').value.trim();
    const repo = document.getElementById('prRepo').value.trim();
    const pullRequestNumber = document.getElementById('prNumber').value.trim();
    
    if (!owner || !repo || !pullRequestNumber) {
        alert('Please fill in all fields');
        return;
    }
    
    const btn = document.getElementById('syncPR');
    btn.disabled = true;
    btn.textContent = '⏳ Adding...';
    
    try {
        // Check if PR already exists
        const exists = allPRs.some(pr => 
            pr.owner === owner && pr.repo === repo && pr.pullRequestNumber === parseInt(pullRequestNumber)
        );
        
        if (exists) {
            alert('ℹ️ This PR is already configured. Use the tabs to switch to it.');
            btn.disabled = false;
            btn.textContent = '🔄 Sync PR';
            return;
        }
        
        // Add the PR
        const response = await fetch('/api/prs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ owner, repo, pullRequestNumber: parseInt(pullRequestNumber) })
        });
        
        const data = await response.json();
        
        if (data.success) {
            allPRs = data.repositories;
            activePRIndex = allPRs.length - 1; // Switch to the newly added PR
            renderPRTabs();
            alert('✅ PR added successfully!');
            await loadData();
        } else {
            alert('❌ ' + (data.error || 'Failed to add PR'));
        }
    } catch (error) {
        alert('❌ Error: ' + error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Sync PR';
    }
}

function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(() => {
        loadData();
    }, refreshInterval);
}

function stopAutoRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

async function loadData(forceRefresh = false) {
    try {
        document.getElementById('loading').style.display = 'block';
        document.getElementById('error').style.display = 'none';
        
        // Fetch data for the active PR
        const url = `/api/data?prIndex=${activePRIndex}${forceRefresh ? '&force=true' : ''}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        researchersConfig = data.researchersConfig;
        renderData(data);
        
        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';
        document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
    } catch (error) {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
        document.getElementById('error').textContent = 'Error: ' + error.message;
    }
}

function renderData(data) {
    setRepositoryContext(data.repository);
    latestRows = data.rows || [];
    latestCommenters = data.commenters || [];
    
    // Check for new comments and update notifications
    checkForNewComments(latestRows);
    
    renderRepoInfo(data.repository);
    renderResearchersSection(data.researchersConfig, data.commenters);
    renderProgressCharts(latestRows, data.duplicateGroups, latestCommenters);
    renderStats(data.stats, data.duplicateGroups, latestRows, latestCommenters);
    renderReactionStats(data.reactionStats, data.commenters);
    renderDuplicateGroups(data.duplicateGroups);
    // Hide duplicate assignments section per request
    const dupAssignSection = document.getElementById('duplicateAssignmentsSection');
    if (dupAssignSection) dupAssignSection.style.display = 'none';
    renderCommentsTable(latestRows, latestCommenters);
    updateColumnControls();
    persistExtraColumnState();
}

function renderRepoInfo(repo) {
    const html = `
        <h3>📦 Repository</h3>
        <p><strong>${repo.owner}/${repo.repo}</strong> - Pull Request #${repo.pullRequestNumber}</p>
    `;
    document.getElementById('repoInfo').innerHTML = html;
}

function renderProgressCharts(rows, duplicateGroups, commenters) {
    // Build a map of duplicate groups for quick lookup
    const duplicateGroupMap = new Map();
    duplicateGroups.forEach(group => {
        group.duplicates.forEach(dup => {
            duplicateGroupMap.set(dup.url, group.groupNumber);
        });
    });
    
    // Identify unique issues (solo + duplicate groups)
    const uniqueIssues = new Map(); // key: groupNumber or url, value: { rows: [], isGroup: bool }
    
    rows.forEach(row => {
        if (row.isDuplicate && row.groupNumber) {
            // Part of a duplicate group
            if (!uniqueIssues.has(row.groupNumber)) {
                uniqueIssues.set(row.groupNumber, { rows: [], isGroup: true });
            }
            uniqueIssues.get(row.groupNumber).rows.push(row);
        } else if (!row.isDuplicate) {
            // Solo issue
            uniqueIssues.set(row.commentUrl || row.Comment?.hyperlink, { rows: [row], isGroup: false });
        }
    });
    
    const totalIssues = uniqueIssues.size;
    let reviewedCount = 0;
    let greenIssuesCount = 0; // Count of issues worth reporting (green rows)
    let reportedCount = 0;
    
    // Calculate review and report progress
    uniqueIssues.forEach((issue, key) => {
        const issueRows = issue.rows;
        
        // Check if ANY row in this issue/group has been reviewed (green OR red)
        // Green = majority thumbs up, Red = majority thumbs down
        // Both count as "reviewed" since the team has made a decision
        const hasReviewed = issueRows.some(row => {
            const totalCommenters = commenters.length;
            const thumbsUpCount = row.thumbsUpCount || 0;
            const thumbsDownCount = row.thumbsDownCount || 0;
            
            // Green row: thumbsUpCount + 1 >= (2/3) * totalCommenters
            const isGreen = (thumbsUpCount + 1) >= Math.ceil((2 / 3) * totalCommenters);
            
            // Red row: thumbsDownCount >= (2/3) * (totalCommenters - 1)
            const isRed = thumbsDownCount >= Math.ceil((2 / 3) * (totalCommenters - 1));
            
            return isGreen || isRed;
        });
        
        if (hasReviewed) {
            reviewedCount++;
        }
        
        // Check if issue is green (worth reporting)
        const isGreenIssue = issueRows.some(row => {
            const totalCommenters = commenters.length;
            const thumbsUpCount = row.thumbsUpCount || 0;
            const isGreen = (thumbsUpCount + 1) >= Math.ceil((2 / 3) * totalCommenters);
            return isGreen;
        });
        
        if (isGreenIssue) {
            greenIssuesCount++;
        }
        
        // Check if ANY row in this issue/group is reported (has rocket emoji AND is green)
        // Only count if the issue has majority thumbs up (green row) AND has rocket
        const hasReported = issueRows.some(row => {
            const totalCommenters = commenters.length;
            const thumbsUpCount = row.thumbsUpCount || 0;
            
            // Must be green (majority thumbs up) AND have rocket emoji
            const isGreen = (thumbsUpCount + 1) >= Math.ceil((2 / 3) * totalCommenters);
            const hasRocket = row.Reported === '✅';
            
            return isGreen && hasRocket;
        });
        
        if (hasReported) {
            reportedCount++;
        }
    });
    
    // Calculate percentages
    const reviewPercentage = totalIssues > 0 ? Math.round((reviewedCount / totalIssues) * 100) : 0;
    // Reporting percentage: reported / green issues (not all issues)
    const reportPercentage = greenIssuesCount > 0 ? Math.round((reportedCount / greenIssuesCount) * 100) : 0;
    
    console.log(`📊 Progress: Total=${totalIssues}, Reviewed=${reviewedCount} (${reviewPercentage}%), Green=${greenIssuesCount}, Reported=${reportedCount}/${greenIssuesCount} (${reportPercentage}%)`);
    
    // Update pie charts
    updatePieChart('reviewProgress', 'reviewPercentage', reviewPercentage, '#28a745');
    updatePieChart('reportProgress', 'reportPercentage', reportPercentage, '#007bff');
    
    // Update labels
    document.getElementById('reviewCompleted').textContent = reviewedCount;
    document.getElementById('reviewTotal').textContent = totalIssues;
    document.getElementById('reportCompleted').textContent = reportedCount;
    document.getElementById('reportTotal').textContent = greenIssuesCount; // Show green issues, not total
}

function updatePieChart(progressId, percentageId, percentage, color) {
    const circumference = 2 * Math.PI * 90; // radius = 90
    const progress = (percentage / 100) * circumference;
    const remaining = circumference - progress;
    
    const progressCircle = document.getElementById(progressId);
    const percentageText = document.getElementById(percentageId);
    
    if (progressCircle) {
        progressCircle.setAttribute('stroke-dasharray', `${progress} ${remaining}`);
        progressCircle.setAttribute('stroke', color);
    }
    
    if (percentageText) {
        percentageText.textContent = `${percentage}%`;
    }
}

function renderResearchersSection(config, commenters) {
    const section = document.getElementById('researchersSection');
    
    if (!config.researchers || config.researchers.length === 0) {
        section.style.display = 'block';
        section.innerHTML = `
            <h3>👥 Researchers</h3>
            <p style="color: #999; font-style: italic;">
                No researchers configured. Click "👥 Manage Researchers" button above to add researchers and filter the view.
            </p>
        `;
        return;
    }

    section.style.display = 'block';
    
    let html = '<h3>👥 Researchers (Filtered View)</h3><div class="researcher-badges">';
    
    config.researchers.forEach(researcher => {
        const isLSR = config.lsr === researcher.handle;
        const badge = `
            <span class="researcher-badge ${isLSR ? 'lsr' : ''}">
                ${researcher.handle}
                ${isLSR ? '⭐ LSR' : ''}
            </span>
        `;
        html += badge;
    });
    
    html += '</div>';
    html += '<p style="color: #666; font-size: 14px; margin-top: 10px;">Only showing issues from these researchers. Click "👥 Manage Researchers" to update.</p>';
    section.innerHTML = html;
}

function renderStats(stats, duplicateGroups, rows, commenters) {
    // Recalculate stats including duplicate groups
    const uniqueIssues = new Map();
    
    rows.forEach(row => {
        if (row.isDuplicate && row.groupNumber) {
            if (!uniqueIssues.has(row.groupNumber)) {
                uniqueIssues.set(row.groupNumber, { rows: [], isGroup: true });
            }
            uniqueIssues.get(row.groupNumber).rows.push(row);
        } else if (!row.isDuplicate) {
            uniqueIssues.set(row.commentUrl || row.Comment?.hyperlink, { rows: [row], isGroup: false });
        }
    });
    
    let reported = 0;
    let nonReported = 0;
    let pending = 0;
    
    uniqueIssues.forEach((issue) => {
        const issueRows = issue.rows;
        const anyResolved = issueRows.some(r => r.isResolved);
        const anyHasRocket = issueRows.some(r => r.Reported === '✅');
        
        if (anyResolved) {
            const totalCommenters = commenters.length;
            const anyGreen = issueRows.some(r => {
                const thumbsUpCount = r.thumbsUpCount || 0;
                return (thumbsUpCount + 1) >= Math.ceil((2 / 3) * totalCommenters);
            });
            
            if (anyGreen && anyHasRocket) {
                reported++;
            } else {
                nonReported++;
            }
        } else {
            pending++;
        }
    });
    
    document.getElementById('reportedCount').textContent = reported;
    document.getElementById('nonReportedCount').textContent = nonReported;
    document.getElementById('pendingCount').textContent = pending;
    document.getElementById('duplicatesCount').textContent = duplicateGroups.length;
}

function renderReactionStats(reactionStats, commenters) {
    let html = '<div class="reaction-stats-grid">';
    
    commenters.forEach(commenter => {
        const stat = reactionStats[commenter];
        const percentage = stat.percentage;
        
        let colorClass = 'percentage-very-low';
        if (percentage >= 90) colorClass = 'percentage-high';
        else if (percentage >= 70) colorClass = 'percentage-medium';
        else if (percentage >= 50) colorClass = 'percentage-low';
        
        html += `
            <div class="reaction-stat ${colorClass}">
                <div class="reaction-stat-header">${commenter}</div>
                <div class="reaction-stat-value">${stat.text}</div>
            </div>
        `;
    });
    
    html += '</div>';
    document.getElementById('reactionStats').innerHTML = html;
}

function renderDuplicateGroups(groups) {
    if (groups.length === 0) {
        document.getElementById('duplicateGroupsSection').style.display = 'none';
        return;
    }
    
    document.getElementById('duplicateGroupsSection').style.display = 'block';
    
    let html = '<table><thead><tr><th>Group #</th><th>Duplicates</th><th>Count</th></tr></thead><tbody>';
    
    groups.forEach(group => {
        const dupLinks = group.duplicates.map((dup, idx) => {
            const subNumber = `${group.groupNumber}.${idx + 1}`;
            return `<a href="${dup.url}" target="_blank">${subNumber} (${dup.proposer})</a>`;
        }).join(', ');
        
        html += `
            <tr>
                <td><strong>${group.groupNumber}</strong></td>
                <td>${dupLinks}</td>
                <td>${group.count}</td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    document.getElementById('duplicateGroups').innerHTML = html;
}

function renderDuplicateAssignments(assignments, commenters) {
    const hasAssignments = Object.values(assignments).some(arr => arr.length > 0);
    
    if (!hasAssignments) {
        document.getElementById('duplicateAssignmentsSection').style.display = 'none';
        return;
    }
    
    document.getElementById('duplicateAssignmentsSection').style.display = 'block';
    
    let html = '<table><thead><tr><th>Auditor</th><th>Assigned Duplicates</th><th>Count</th></tr></thead><tbody>';
    
    commenters.forEach(commenter => {
        const auditorAssignments = assignments[commenter] || [];
        if (auditorAssignments.length > 0) {
            const links = auditorAssignments.map(a => 
                `<a href="${a.duplicateUrl}" target="_blank">Dup of ${a.originalProposer}'s finding</a>`
            ).join('<br>');
            
            html += `
                <tr>
                    <td>${commenter}</td>
                    <td>${links}</td>
                    <td>${auditorAssignments.length}</td>
                </tr>
            `;
        }
    });
    
    html += '</tbody></table>';
    document.getElementById('duplicateAssignments').innerHTML = html;
}

function renderTableRow(row, commenters, isInDuplicateGroup, groupId, allRows) {
    const thumbsUpCount = row.thumbsUpCount;
    const thumbsDownCount = row.thumbsDownCount;
    const totalCommenters = commenters.length;
    
    let rowClass = '';
    if (thumbsUpCount + 1 >= (2 / 3) * totalCommenters) {
        rowClass = 'green-row';
    } else if (thumbsDownCount >= (2 / 3) * (totalCommenters - 1)) {
        rowClass = 'red-row';
    }
    
    // Add collapsible class if in duplicate group
    if (isInDuplicateGroup && groupId) {
        rowClass += ' duplicate-group-row';
    }
    
    const groupIdAttr = isInDuplicateGroup && groupId ? ` data-group-id="${groupId}"` : '';
    let html = `<tr class="${rowClass}"${groupIdAttr}>`;
    
        // Issue number with resolution status
        html += `<td>`;
        html += `<strong>${row.issueNumber}</strong>`;
        if (row.isResolved) {
            html += `<span class="resolved-badge" title="Thread resolved">✓</span>`;
        }
        html += `</td>`;
    
    // Comment with thread view
    const hasReplies = row.replyCount > 0;
    const threadId = `thread-${encodeURIComponent(row.commentUrl)}`;
    
    html += `<td class="comment-cell">`;
    
    // Main comment with expand button if there are replies
    if (hasReplies) {
        html += `<div class="comment-header">`;
        html += `<button class="thread-toggle" data-thread-id="${threadId}">▶ ${row.replyCount} ${row.replyCount === 1 ? 'reply' : 'replies'}</button>`;
        html += `<a href="${row.Comment.hyperlink}" target="_blank">${row.Comment.text}</a>`;
        html += `</div>`;
        
        // Thread view (collapsed by default)
        html += `<div class="thread-view" id="${threadId}" style="display: none;">`;
        
        // Original comment
        html += `<div class="thread-comment original">`;
        html += `<div class="comment-author">${row.proposer}</div>`;
        html += `<div class="comment-body">${escapeHtml(row.Comment.fullText || row.Comment.text)}</div>`;
        
        // Show reactions on original comment
        const originalReactions = [];
        commenters.forEach(commenter => {
            const emoji = row[commenter];
            if (emoji && emoji !== 'Proposer' && commenter !== row.proposer) {
                originalReactions.push({ emoji, user: commenter });
            }
        });
        
        if (originalReactions.length > 0) {
            html += `<div class="comment-reactions">`;
            originalReactions.forEach(r => {
                html += `<span class="reaction">${r.emoji} ${r.user}</span>`;
            });
            html += `</div>`;
        }
        
        html += `</div>`;
        
        // Replies
        if (row.threadReplies) {
            row.threadReplies.forEach(reply => {
                html += `<div class="thread-comment reply">`;
                html += `<div class="comment-meta">`;
                html += `<span class="comment-author">${reply.author}</span>`;
                html += `<span class="comment-time">${formatTimestamp(reply.createdAt)}</span>`;
                html += `</div>`;
                html += `<div class="comment-body">${escapeHtml(reply.body)}</div>`;
                
                // Show reactions if any
                if (reply.reactions && reply.reactions.length > 0) {
                    html += `<div class="comment-reactions">`;
                    reply.reactions.forEach(r => {
                        html += `<span class="reaction">${r.content} ${r.user}</span>`;
                    });
                    html += `</div>`;
                }
                
                html += `</div>`;
            });
        }
        
        html += `</div>`;
    } else {
        html += `<a href="${row.Comment.hyperlink}" target="_blank">${row.Comment.text}</a>`;
    }
    
    html += `</td>`;
    
    // Reported
    html += `<td>${row.Reported || ''}</td>`;
    
    // Duplicate
    if (row.isDuplicate) {
        let dupText = `<strong>${row.proposer}</strong><br>`;
        dupText += `Group: <strong>${row.groupNumber}</strong>`;
        
        if (row.isAutoDuplicate) {
            dupText += `<br><button class="btn-undupe" onclick="undupeFinding('${row.commentUrl}', '${row.duplicateOf}')">❌ Undupe</button>`;
        }
        
        if (row.otherSpotters && row.otherSpotters.length > 0) {
            dupText += `<br><small>Also spotted by: ${row.otherSpotters.join(', ')}</small>`;
        }
        html += `<td>${dupText}</td>`;
    } else {
        html += `<td></td>`;
    }
    
    // Check for LSR assignment in thread replies
    // For duplicates, check the primary comment (D-X.1) in the group
    let lsrAssignment = null;
    
    if (row.isDuplicate && row.groupNumber) {
        // Find the primary comment (D-X.1) in this group
        const primaryIssueNumber = `${row.groupNumber}.1`;
        const primaryRow = allRows.find(r => r.issueNumber === primaryIssueNumber);
        
        if (primaryRow && primaryRow.threadReplies && primaryRow.threadReplies.length > 0) {
            const lsrComment = primaryRow.threadReplies.find(r => 
                r.body && r.body.startsWith('PIC of reporting:')
            );
            if (lsrComment) {
                lsrAssignment = {
                    body: lsrComment.body,
                    author: lsrComment.author,
                    id: lsrComment.numericId || lsrComment.id,
                    primaryCommentUrl: primaryRow.commentUrl
                };
            }
        }
    } else if (row.threadReplies && row.threadReplies.length > 0) {
        // For non-duplicates, check their own thread
        const lsrComment = row.threadReplies.find(r => 
            r.body && r.body.startsWith('PIC of reporting:')
        );
        if (lsrComment) {
            lsrAssignment = {
                body: lsrComment.body,
                author: lsrComment.author,
                id: lsrComment.numericId || lsrComment.id
            };
        }
    }
    
    const assignedTo = lsrAssignment ? lsrAssignment.body : (row.assignedTo || '');
    const rowKey = getRowKey(row);
    const encodedRowKey = encodeURIComponent(rowKey);
    const assignedToValue = escapeAttribute(assignedTo);
    
    let dataAttrs = `data-url="${row.Comment.hyperlink}" data-row-key="${encodedRowKey}"`;
    if (row.isDuplicate && row.duplicateOf) {
        const groupUrls = [row.commentUrl, row.duplicateOf].sort();
        const groupIdAttr = groupUrls.join('||');
        dataAttrs += ` data-duplicate-group="${groupIdAttr}" data-is-duplicate="true"`;
    }
    
    html += `<td class="assigned-to-cell">`;
    
    if (lsrAssignment) {
        // Show LSR assignment (read-only, with hover for full text)
        const shortText = lsrAssignment.body.split('\n')[0]; // First line only
        html += `<div class="lsr-assignment" title="${escapeAttribute(lsrAssignment.body)}">`;
        html += `<span class="lsr-text">${escapeHtml(shortText)}</span>`;
        
        // Edit/Remove buttons (only for LSR)
        if (researchersConfig.lsr) {
            html += `<button class="lsr-edit-btn" data-group="${row.groupNumber}" data-comment-url="${row.commentUrl}" data-comment-id="${lsrAssignment.id}" title="Edit assignment">✏️</button>`;
            html += `<button class="lsr-remove-btn" data-comment-id="${lsrAssignment.id}" title="Remove assignment">🗑️</button>`;
        }
        
        html += `</div>`;
    } else {
        html += `<input type="text" class="assigned-to-input" ${dataAttrs} value="${assignedToValue}" placeholder="Assign to...">`;
        
        // Add LSR assignment button for duplicate groups (only if user is LSR)
        if (row.isDuplicate && row.groupNumber && researchersConfig.lsr) {
            const isFirstInGroup = row.issueNumber.endsWith('.1');
            if (isFirstInGroup) {
                html += `<button class="lsr-assign-btn" data-group="${row.groupNumber}" data-comment-url="${row.commentUrl}" title="Assign PIC of Reporting (LSR only)">👑</button>`;
            }
        }
    }
    
    html += `</td>`;
    
    commenters.forEach(commenter => {
        const value = row[commenter];
        html += `<td>${value || ''}</td>`;
    });

    extraColumns.forEach((column, columnIndex) => {
        const columnStore = extraColumnData[column.id] || {};
        const columnValue = columnStore[rowKey] || '';
        const safeValue = escapeAttribute(columnValue);
        const placeholder = escapeAttribute(column.name || getDefaultColumnName(columnIndex));
        html += `<td><input type="text" class="extra-column-input" data-column-id="${column.id}" data-row-key="${encodedRowKey}" value="${safeValue}" placeholder="${placeholder}"></td>`;
    });
    
    html += '</tr>';
    return html;
}

function toggleThread(threadId, button) {
    const threadView = document.getElementById(threadId);
    if (!threadView) return;
    
    const isCollapsed = threadView.style.display === 'none';
    
    if (isCollapsed) {
        threadView.style.display = 'block';
        button.textContent = button.textContent.replace('▶', '▼');
    } else {
        threadView.style.display = 'none';
        button.textContent = button.textContent.replace('▼', '▶');
    }
}

function toggleDuplicateGroup(groupId) {
    const rows = document.querySelectorAll(`tr[data-group-id="${groupId}"]`);
    const icon = document.querySelector(`.collapse-icon[data-group-id="${groupId}"]`);
    
    if (!rows.length || !icon) return;
    
    // Check if currently collapsed by checking the second row (first is always visible)
    const secondRow = rows[1];
    const isCollapsed = secondRow && (window.getComputedStyle(secondRow).display === 'none' || secondRow.style.display === 'none');
    
    // Toggle visibility: always keep first row (D-X.1) visible, toggle the rest
    rows.forEach((row, index) => {
        if (index === 0) {
            // First row (D-X.1) always visible
            row.style.display = '';
            
            // Add bottom border when collapsed to separate from next content
            if (!isCollapsed) {
                // Collapsing: add thick bottom border
                row.classList.add('collapsed-group-last');
            } else {
                // Expanding: remove bottom border
                row.classList.remove('collapsed-group-last');
            }
        } else {
            // Rest of the rows toggle
            if (isCollapsed) {
                // Expand: show all rows
                row.style.display = '';
            } else {
                // Collapse: hide rows except first
                row.style.display = 'none';
            }
        }
    });
    
    // Update icon
    icon.textContent = isCollapsed ? '▼' : '▶';
}

function renderCommentsTable(rows, commenters) {
    extraColumns.forEach(column => {
        if (!extraColumnData[column.id]) {
            extraColumnData[column.id] = {};
        }
    });

    // Headers
    let headHtml = '<tr><th>#</th><th>Comment</th><th>Reported</th><th>Duplicate</th><th>Assigned To</th>';
    commenters.forEach(commenter => {
        headHtml += `<th>${commenter}</th>`;
    });
    extraColumns.forEach(column => {
        const safeName = escapeAttribute(column.name || '');
        headHtml += `
            <th class="extra-column-header" data-column-id="${column.id}">
                <input type="text" class="extra-column-header-input" data-column-id="${column.id}" value="${safeName}" placeholder="Column name">
            </th>`;
    });
    headHtml += '</tr>';
    document.getElementById('commentsTableHead').innerHTML = headHtml;
    
    // Group rows by duplicate groups
    const duplicateGroups = new Map(); // groupNumber -> [rows]
    const regularRows = [];
    
    rows.forEach(row => {
        if (row.isDuplicate && row.groupNumber) {
            if (!duplicateGroups.has(row.groupNumber)) {
                duplicateGroups.set(row.groupNumber, []);
            }
            duplicateGroups.get(row.groupNumber).push(row);
        } else {
            regularRows.push(row);
        }
    });
    
    // Body
    let bodyHtml = '';
    
    // Render duplicate groups with collapsible headers FIRST (at the top)
    const sortedGroups = Array.from(duplicateGroups.entries()).sort((a, b) => {
        // Extract numeric part from "D-1", "D-2", etc.
        const numA = parseInt(a[0].replace(/^D-/, '')) || 0;
        const numB = parseInt(b[0].replace(/^D-/, '')) || 0;
        return numA - numB;
    });
    
    sortedGroups.forEach(([groupNumber, groupRows]) => {
        // Group header row (always visible, clickable) - NO data-group-id on header!
        const groupId = `dup-group-${groupNumber}`;
        bodyHtml += `<tr class="duplicate-group-header" data-header-for="${groupId}">`;
        bodyHtml += `<td colspan="${5 + commenters.length + extraColumns.length}" style="background-color: #e8f4f8; cursor: pointer; font-weight: bold; padding: 10px;">`;
        bodyHtml += `<span class="collapse-icon" data-group-id="${groupId}" style="font-size: 1.2em; font-weight: bold; margin-right: 10px; display: inline-block; min-width: 20px;">▼</span>`;
        bodyHtml += `<span style="font-size: 1.1em;">Duplicate Group ${groupNumber} (${groupRows.length} issue${groupRows.length > 1 ? 's' : ''})</span>`;
        bodyHtml += `</td></tr>`;
        
        // Group rows (collapsible) - these have data-group-id
        groupRows.forEach(row => {
            bodyHtml += renderTableRow(row, commenters, true, groupId, rows);
        });
    });
    
    // Render regular (non-duplicate) rows after duplicates
    regularRows.forEach(row => {
        bodyHtml += renderTableRow(row, commenters, false, null, rows);
    });
    
    document.getElementById('commentsTableBody').innerHTML = bodyHtml;
    
    // Add click handlers for collapse/expand
    document.querySelectorAll('.duplicate-group-header').forEach(header => {
        header.addEventListener('click', function() {
            const groupId = this.dataset.headerFor;
            toggleDuplicateGroup(groupId);
        });
    });
    
    // Thread toggle buttons
    document.querySelectorAll('.thread-toggle').forEach(button => {
        button.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            const threadId = this.dataset.threadId;
            toggleThread(threadId, this);
        });
    });
    
    // LSR assignment buttons
    document.querySelectorAll('.lsr-assign-btn').forEach(button => {
        button.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            const groupNumber = this.dataset.group;
            const commentUrl = this.dataset.commentUrl;
            openLSRAssignmentModal(groupNumber, commentUrl);
        });
    });
    
    // LSR edit buttons
    document.querySelectorAll('.lsr-edit-btn').forEach(button => {
        button.addEventListener('click', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            const commentId = this.dataset.commentId;
            const groupNumber = this.dataset.group;
            const commentUrl = this.dataset.commentUrl;
            
            // Delete old comment first
            if (await deleteLSRComment(commentId)) {
                // Open modal to create new assignment
                openLSRAssignmentModal(groupNumber, commentUrl);
            }
        });
    });
    
    // LSR remove buttons
    document.querySelectorAll('.lsr-remove-btn').forEach(button => {
        button.addEventListener('click', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            const commentId = this.dataset.commentId;
            
            if (confirm('Remove this PIC assignment?')) {
                await deleteLSRComment(commentId);
            }
        });
    });
    
    document.querySelectorAll('.assigned-to-input').forEach(input => {
        input.addEventListener('blur', async (e) => {
            const url = e.target.dataset.url;
            const assignedTo = e.target.value.trim();
            const isDuplicate = e.target.dataset.isDuplicate === 'true';
            const duplicateOf = e.target.dataset.duplicateOf;
            
            await saveAssignment(url, assignedTo, isDuplicate, duplicateOf);
        });
    });

    document.querySelectorAll('.extra-column-input').forEach(input => {
        input.addEventListener('input', (e) => {
            const columnId = e.target.dataset.columnId;
            const rowKey = decodeURIComponent(e.target.dataset.rowKey || '');
            if (!extraColumnData[columnId]) {
                extraColumnData[columnId] = {};
            }
            extraColumnData[columnId][rowKey] = e.target.value;
            persistExtraColumnState();
        });
    });

    document.querySelectorAll('.extra-column-header-input').forEach(input => {
        input.addEventListener('input', (e) => {
            const columnId = e.target.dataset.columnId;
            const columnIndex = extraColumns.findIndex(c => c.id === columnId);
            if (columnIndex >= 0) {
                const column = extraColumns[columnIndex];
                column.name = e.target.value;
                const placeholder = column.name || getDefaultColumnName(columnIndex);
                document.querySelectorAll(`.extra-column-input[data-column-id="${columnId}"]`).forEach(colInput => {
                    colInput.placeholder = placeholder;
                });
                persistExtraColumnState();
            }
        });

        input.addEventListener('blur', (e) => {
            const columnId = e.target.dataset.columnId;
            const columnIndex = extraColumns.findIndex(c => c.id === columnId);
            if (columnIndex >= 0) {
                const column = extraColumns[columnIndex];
                if (!column.name || column.name.trim() === '') {
                    column.name = getDefaultColumnName(columnIndex);
                    e.target.value = column.name;
                }
                document.querySelectorAll(`.extra-column-input[data-column-id="${columnId}"]`).forEach(colInput => {
                    colInput.placeholder = column.name;
                });
                persistExtraColumnState();
            }
        });
    });
}

async function saveAssignment(commentUrl, assignedTo, isDuplicate, duplicateOf) {
    try {
        // If this is a duplicate, collect all duplicate URLs to save them all at once
        let urlsToSave = [commentUrl];
        
        console.log('💾 Saving assignment:', {
            commentUrl,
            assignedTo,
            isDuplicate,
            duplicateOf
        });
        
        if (isDuplicate && duplicateOf) {
            // Find the group ID for this duplicate
            const currentInput = document.querySelector(`.assigned-to-input[data-url="${commentUrl}"]`);
            const groupId = currentInput?.dataset.duplicateGroup;
            
            if (groupId) {
                // Find all inputs in the same duplicate group
                const allDuplicateInputs = document.querySelectorAll(`.assigned-to-input[data-duplicate-group="${groupId}"]`);
                console.log(`Found ${allDuplicateInputs.length} duplicates in the same group`);
                
                allDuplicateInputs.forEach(input => {
                    const url = input.dataset.url;
                    console.log('  - Duplicate URL:', url);
                    if (!urlsToSave.includes(url)) {
                        urlsToSave.push(url);
                    }
                });
            }
        }
        
        console.log(`📝 Saving assignments for ${urlsToSave.length} URL(s)`);
        
        // Save all assignments
        const response = await fetch('/api/save-assignment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                urls: urlsToSave,
                assignedTo
            })
        });
        
        const result = await response.json();
        if (result.success) {
            // Update UI for all duplicates in the same group
            if (isDuplicate) {
                const currentInput = document.querySelector(`.assigned-to-input[data-url="${commentUrl}"]`);
                const groupId = currentInput?.dataset.duplicateGroup;
                if (groupId) {
                    updateDuplicateAssignmentsByGroup(groupId, assignedTo);
                }
            }
            console.log('✅ Assignment saved successfully');
        } else {
            console.error('Failed to save assignment');
        }
    } catch (error) {
        console.error('Error saving assignment:', error);
    }
}

function updateDuplicateAssignmentsByGroup(groupId, assignedTo) {
    // Find all inputs in the same duplicate group
    document.querySelectorAll(`.assigned-to-input[data-duplicate-group="${groupId}"]`).forEach(input => {
        input.value = assignedTo;
    });
}

// LSR Assignment System
function openLSRAssignmentModal(groupNumber, primaryCommentUrl) {
    currentLSRAssignment = { groupNumber, primaryCommentUrl };
    
    const modal = document.getElementById('lsrAssignmentModal');
    const checkboxesContainer = document.getElementById('srCheckboxes');
    
    // Render SR checkboxes
    let html = '';
    researchersConfig.researchers.forEach(researcher => {
        html += `<div class="sr-checkbox-item">`;
        html += `<input type="checkbox" id="sr-${researcher.handle}" value="${researcher.handle}">`;
        html += `<label for="sr-${researcher.handle}">${researcher.handle}${researcher.handle === researchersConfig.lsr ? ' ⭐' : ''}</label>`;
        html += `</div>`;
    });
    
    checkboxesContainer.innerHTML = html;
    
    // Clear guidance field
    document.getElementById('lsrGuidance').value = '';
    
    modal.style.display = 'block';
}

async function deleteLSRComment(commentId) {
    try {
        const activePR = allPRs[activePRIndex];
        const response = await fetch('/api/delete-comment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                owner: activePR.owner,
                repo: activePR.repo,
                prNumber: activePR.pullRequestNumber,
                commentId: parseInt(commentId)
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert('✅ Assignment removed!');
            loadData(true); // Force refresh to show changes
            return true;
        } else {
            alert('❌ Failed to remove assignment: ' + (result.error || 'Unknown error'));
            return false;
        }
    } catch (error) {
        alert('❌ Error removing assignment: ' + error.message);
        return false;
    }
}

async function submitLSRAssignment() {
    if (!currentLSRAssignment) return;
    
    // Get selected SRs
    const selectedSRs = [];
    researchersConfig.researchers.forEach(researcher => {
        const checkbox = document.getElementById(`sr-${researcher.handle}`);
        if (checkbox && checkbox.checked) {
            selectedSRs.push(researcher.handle);
        }
    });
    
    if (selectedSRs.length === 0) {
        alert('Please select at least one SR');
        return;
    }
    
    const guidance = document.getElementById('lsrGuidance').value.trim();
    
    // Build comment body
    let commentBody = `PIC of reporting: ${selectedSRs.join(', ')}`;
    if (guidance) {
        commentBody += `\n\n${guidance}`;
    }
    
    try {
        const activePR = allPRs[activePRIndex];
        const response = await fetch('/api/post-comment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                owner: activePR.owner,
                repo: activePR.repo,
                prNumber: activePR.pullRequestNumber,
                commentUrl: currentLSRAssignment.primaryCommentUrl,
                body: commentBody
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert('✅ Assignment posted to GitHub!');
            document.getElementById('lsrAssignmentModal').style.display = 'none';
            // Refresh to show the new comment
            loadData(true);
        } else {
            alert('❌ Failed to post assignment: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        alert('❌ Error posting assignment: ' + error.message);
    }
}

// Researchers management
async function loadResearchersModal() {
    try {
        if (allPRs.length === 0) {
            alert('Please add a PR first');
            return;
        }
        
        const activePR = allPRs[activePRIndex];
        const response = await fetch(`/api/researchers?owner=${activePR.owner}&repo=${activePR.repo}&prNumber=${activePR.pullRequestNumber}`);
        const config = await response.json();
        researchersConfig = config;
        renderResearchersList();
    } catch (error) {
        alert('Error loading researchers: ' + error.message);
    }
}

function renderResearchersList() {
    const list = document.getElementById('researchersList');
    
    if (!researchersConfig.researchers || researchersConfig.researchers.length === 0) {
        list.innerHTML = '<p style="color: #666;">No researchers added yet.</p>';
        return;
    }
    
    let html = '';
    researchersConfig.researchers.forEach((researcher, index) => {
        const isLSR = researchersConfig.lsr === researcher.handle;
        html += `
            <div class="researcher-item">
                <div class="researcher-item-info">
                    <strong>${researcher.handle}</strong>
                    ${isLSR ? '<span>⭐ LSR</span>' : ''}
                </div>
                <div class="researcher-item-actions">
                    ${!isLSR ? `<button class="btn btn-small btn-primary" onclick="setLSR('${researcher.handle}')">Set as LSR</button>` : ''}
                    <button class="btn btn-small btn-danger" onclick="removeResearcher(${index})">Remove</button>
                </div>
            </div>
        `;
    });
    
    html += `
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; text-align: center;">
            <button class="btn btn-danger" onclick="clearAllResearchers()">Clear All (Show All Issues)</button>
        </div>
    `;
    
    list.innerHTML = html;
}

async function clearAllResearchers() {
    if (!confirm('This will remove all researchers and show ALL issues. Continue?')) {
        return;
    }
    
    researchersConfig.researchers = [];
    researchersConfig.lsr = null;
    
    try {
        await saveResearchers();
        renderResearchersList();
        loadData(); // Refresh main data
    } catch (error) {
        alert('Error clearing researchers: ' + error.message);
    }
}

async function addResearcher() {
    const input = document.getElementById('newResearcherHandle');
    const handle = input.value.trim();
    
    if (!handle) {
        alert('Please enter a GitHub handle');
        return;
    }
    
    if (researchersConfig.researchers.some(r => r.handle === handle)) {
        alert('Researcher already exists');
        return;
    }
    
    researchersConfig.researchers.push({ handle });
    
    try {
        await saveResearchers();
        input.value = '';
        renderResearchersList();
        loadData(); // Refresh main data
    } catch (error) {
        alert('Error adding researcher: ' + error.message);
    }
}

async function removeResearcher(index) {
    if (!confirm('Are you sure you want to remove this researcher?')) {
        return;
    }
    
    const removed = researchersConfig.researchers[index];
    researchersConfig.researchers.splice(index, 1);
    
    // If removed researcher was LSR, clear LSR
    if (researchersConfig.lsr === removed.handle) {
        researchersConfig.lsr = null;
    }
    
    try {
        await saveResearchers();
        renderResearchersList();
        loadData(); // Refresh main data
    } catch (error) {
        alert('Error removing researcher: ' + error.message);
    }
}

async function setLSR(handle) {
    researchersConfig.lsr = handle;
    
    try {
        await saveResearchers();
        renderResearchersList();
        loadData(); // Refresh main data
    } catch (error) {
        alert('Error setting LSR: ' + error.message);
    }
}

async function saveResearchers() {
    if (allPRs.length === 0) {
        throw new Error('No active PR');
    }
    
    const activePR = allPRs[activePRIndex];
    const response = await fetch('/api/researchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            owner: activePR.owner,
            repo: activePR.repo,
            prNumber: activePR.pullRequestNumber,
            researchers: researchersConfig.researchers,
            lsr: researchersConfig.lsr
        })
    });
    
    const result = await response.json();
    if (!result.success) {
        throw new Error('Failed to save researchers');
    }
}

// Undupe an auto-detected duplicate
async function undupeFinding(commentUrl, duplicateOf) {
    if (!confirm('Remove this auto-detected duplicate relationship?')) {
        return;
    }
    
    try {
        const response = await fetch('/api/undupe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commentUrl, duplicateOf })
        });
        
        const result = await response.json();
        if (result.success) {
            alert('✅ Duplicate relationship removed. Refreshing...');
            await loadData();
        } else {
            alert('❌ Error removing duplicate');
        }
    } catch (error) {
        alert('❌ Error: ' + error.message);
    }
}

