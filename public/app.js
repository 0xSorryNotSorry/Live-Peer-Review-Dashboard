let refreshInterval = 20000; // Default 20 seconds
let refreshTimer = null;
let researchersConfig = { researchers: [], lsr: null };
let extraColumns = [];
let extraColumnData = {};
let latestRows = [];
let latestCommenters = [];
let isNightMode = false;
let currentRepoKey = null;

const EXTRA_COLUMNS_PREFIX = 'arm-extra-columns:';
const EXTRA_COLUMN_DATA_PREFIX = 'arm-extra-column-data:';

function escapeAttribute(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/"/g, '&quot;');
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
    loadCurrentConfig();
    loadData();
    // Don't start auto-refresh by default (manual mode is selected)
});

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

async function loadCurrentConfig() {
    try {
        const response = await fetch('/api/data');
        const data = await response.json();
        
        if (data.repository) {
            document.getElementById('prOwner').value = data.repository.owner;
            document.getElementById('prRepo').value = data.repository.repo;
            document.getElementById('prNumber').value = data.repository.pullRequestNumber;
        }
    } catch (error) {
        console.error('Error loading config:', error);
    }
}

async function syncPR() {
    const owner = document.getElementById('prOwner').value.trim();
    const repo = document.getElementById('prRepo').value.trim();
    const prNumber = parseInt(document.getElementById('prNumber').value);
    
    if (!owner || !repo || !prNumber) {
        alert('Please fill in all PR fields');
        return;
    }
    
    const btn = document.getElementById('syncPR');
    btn.disabled = true;
    btn.textContent = '⏳ Syncing...';
    
    try {
        const response = await fetch('/api/update-pr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ owner, repo, pullRequestNumber: prNumber })
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

async function loadData() {
    try {
        document.getElementById('loading').style.display = 'block';
        document.getElementById('error').style.display = 'none';
        
        const response = await fetch('/api/data');
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
    renderRepoInfo(data.repository);
    renderResearchersSection(data.researchersConfig, data.commenters);
    renderStats(data.stats, data.duplicateGroups);
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

function renderStats(stats, duplicateGroups) {
    document.getElementById('reportedCount').textContent = stats.reported;
    document.getElementById('nonReportedCount').textContent = stats.nonReported;
    document.getElementById('pendingCount').textContent = stats.pending;
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
    
    // Body
    let bodyHtml = '';
    rows.forEach(row => {
        const thumbsUpCount = row.thumbsUpCount;
        const thumbsDownCount = row.thumbsDownCount;
        const totalCommenters = commenters.length;
        
        let rowClass = '';
        if (thumbsUpCount + 1 >= (2 / 3) * totalCommenters) {
            rowClass = 'green-row';
        } else if (thumbsDownCount >= (2 / 3) * (totalCommenters - 1)) {
            rowClass = 'red-row';
        }
        
        bodyHtml += `<tr class="${rowClass}">`;
        
        // Issue number
        bodyHtml += `<td><strong>${row.issueNumber}</strong></td>`;
        
        // Comment
        bodyHtml += `<td><a href="${row.Comment.hyperlink}" target="_blank">${row.Comment.text}</a></td>`;
        
        // Reported
        bodyHtml += `<td>${row.Reported || ''}</td>`;
        
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
            bodyHtml += `<td>${dupText}</td>`;
        } else {
            bodyHtml += `<td></td>`;
        }
        
        const assignedTo = row.assignedTo || '';
        const rowKey = getRowKey(row);
        const encodedRowKey = encodeURIComponent(rowKey);
        const assignedToValue = escapeAttribute(assignedTo);
        
        let dataAttrs = `data-url="${row.Comment.hyperlink}" data-row-key="${encodedRowKey}"`;
        if (row.isDuplicate && row.duplicateOf) {
            const groupUrls = [row.commentUrl, row.duplicateOf].sort();
            const groupId = groupUrls.join('||');
            dataAttrs += ` data-duplicate-group="${groupId}" data-is-duplicate="true"`;
        }
        
        bodyHtml += `<td><input type="text" class="assigned-to-input" ${dataAttrs} value="${assignedToValue}" placeholder="Assign to..."></td>`;
        
        commenters.forEach(commenter => {
            const value = row[commenter];
            bodyHtml += `<td>${value || ''}</td>`;
        });

        extraColumns.forEach((column, columnIndex) => {
            const columnStore = extraColumnData[column.id] || {};
            const columnValue = columnStore[rowKey] || '';
            const safeValue = escapeAttribute(columnValue);
            const placeholder = escapeAttribute(column.name || getDefaultColumnName(columnIndex));
            bodyHtml += `<td><input type="text" class="extra-column-input" data-column-id="${column.id}" data-row-key="${encodedRowKey}" value="${safeValue}" placeholder="${placeholder}"></td>`;
        });
        
        bodyHtml += '</tr>';
    });
    
    document.getElementById('commentsTableBody').innerHTML = bodyHtml;
    
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

// Researchers management
async function loadResearchersModal() {
    try {
        const response = await fetch('/api/researchers');
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
    const response = await fetch('/api/researchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(researchersConfig)
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

