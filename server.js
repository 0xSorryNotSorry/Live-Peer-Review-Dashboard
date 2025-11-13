import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import fs from 'fs/promises';
import { getPRReviewCommentsWithReactions, generatePDF } from './dataFetcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// In-memory undupe flags (cleared on server restart)
const undupeFlags = {};

// Data directory for configs and app-generated files (defaults to working directory)
const DATA_DIR = process.env.APP_DATA_DIR ? resolve(process.env.APP_DATA_DIR) : process.cwd();
function dataPath(filename) {
    return join(DATA_DIR, filename);
}
async function ensureDataDir() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
    } catch (_) {
        // ignore
    }
}

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Load config
async function loadConfig() {
    try {
        const configFile = process.env.CONFIG_FILE
            ? resolve(process.env.CONFIG_FILE)
            : (process.env.CONFIG_DIR ? join(resolve(process.env.CONFIG_DIR), 'config.json') : dataPath('config.json'));
        const data = await fs.readFile(configFile, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist, return null (not an error on first run)
            return null;
        }
        console.error('Error reading config file:', error);
        return null;
    }
}

// Load researchers config
async function loadResearchers() {
    try {
        const data = await fs.readFile(dataPath('researchers.json'), 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // Create default if doesn't exist
        const defaultResearchers = {
            researchers: [],
            lsr: null
        };
        await ensureDataDir();
        await fs.writeFile(dataPath('researchers.json'), JSON.stringify(defaultResearchers, null, 2));
        return defaultResearchers;
    }
}

// Load assignments
async function loadAssignments() {
    try {
        const data = await fs.readFile(dataPath('assignments.json'), 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

// Save assignments
async function saveAssignments(assignments) {
    await ensureDataDir();
    await fs.writeFile(dataPath('assignments.json'), JSON.stringify(assignments, null, 2));
}

// Save researchers config
async function saveResearchers(researchers) {
    await ensureDataDir();
    await fs.writeFile(dataPath('researchers.json'), JSON.stringify(researchers, null, 2));
}

// API: Get PR data
app.get('/api/data', async (req, res) => {
    try {
        const config = await loadConfig();
        const researchersConfig = await loadResearchers();
        const assignments = await loadAssignments();
        
        if (!config || !config.repositories || config.repositories.length === 0) {
            return res.status(400).json({ error: 'No repository configured' });
        }

        // Get active PR index from query param or use first PR
        const prIndex = parseInt(req.query.prIndex) || 0;
        if (prIndex >= config.repositories.length) {
            return res.status(400).json({ error: 'Invalid PR index' });
        }

        const repo = config.repositories[prIndex];
        const data = await getPRReviewCommentsWithReactions(
            repo.owner,
            repo.repo,
            repo.pullRequestNumber,
            undupeFlags  // Pass in-memory undupe flags
        );

        // Filter by researchers if configured
        if (researchersConfig.researchers.length > 0) {
            const allowedHandles = researchersConfig.researchers.map(r => r.handle);
            data.rows = data.rows.filter(row => allowedHandles.includes(row.proposer));
            data.commenters = data.commenters.filter(c => allowedHandles.includes(c));
        }

        // Add assignments to rows
        // For duplicates: only use saved assignment if it exists, otherwise leave empty
        // For regular issues: use saved assignment or default to proposer
        data.rows = data.rows.map(row => {
            const savedAssignment = assignments[row.Comment.hyperlink];
            let assignedTo = '';
            
            if (savedAssignment) {
                // Use saved assignment if it exists
                assignedTo = savedAssignment;
            } else if (!row.isDuplicate) {
                // For non-duplicates, default to proposer
                assignedTo = row.proposer;
            }
            // For duplicates without saved assignment, leave empty
            
            return {
                ...row,
                assignedTo
            };
        });

        res.json({
            ...data,
            repository: repo,
            researchersConfig
        });
    } catch (error) {
        console.error('Error fetching data:', error);
        
        // Check if it's a rate limit error
        if (error.message && error.message.includes('rate limit')) {
            return res.status(429).json({ 
                error: 'GitHub API rate limit exceeded. Please wait and try again later.',
                isRateLimit: true
            });
        }
        
        res.status(500).json({ error: error.message });
    }
});

// API: Get researchers
app.get('/api/researchers', async (req, res) => {
    try {
        const researchers = await loadResearchers();
        res.json(researchers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Update researchers
app.post('/api/researchers', async (req, res) => {
    try {
        await saveResearchers(req.body);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Update PR configuration
app.post('/api/update-pr', async (req, res) => {
    try {
        const { owner, repo, pullRequestNumber } = req.body;
        
        if (!owner || !repo || !pullRequestNumber) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const config = await loadConfig() || { repositories: [] };
        config.repositories = [{
            owner,
            repo,
            pullRequestNumber
        }];
        config.name = `${repo}_Review`;
        
        await ensureDataDir();
        const configFile = process.env.CONFIG_FILE
            ? resolve(process.env.CONFIG_FILE)
            : (process.env.CONFIG_DIR ? join(resolve(process.env.CONFIG_DIR), 'config.json') : dataPath('config.json'));
        await fs.writeFile(configFile, JSON.stringify(config, null, 4));
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating PR config:', error);
        res.status(500).json({ error: error.message });
    }
});

// API: Save assignment
app.post('/api/save-assignment', async (req, res) => {
    try {
        const { urls, assignedTo } = req.body;
        
        const assignments = await loadAssignments();
        
        // Save assignments for all provided URLs
        urls.forEach(url => {
            assignments[url] = assignedTo;
        });
        
        await saveAssignments(assignments);
        console.log(`✅ Saved assignments for ${urls.length} issue(s) to: ${assignedTo}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Error saving assignment:', error);
        res.status(500).json({ error: error.message });
    }
});

// API: Undupe a finding (mark auto-duplicate as not duplicate)
app.post('/api/undupe', async (req, res) => {
    try {
        const { commentUrl, duplicateOf } = req.body;
        
        // Mark this relationship as unduped (in-memory only, cleared on restart)
        const key = `${commentUrl}->${duplicateOf}`;
        undupeFlags[key] = true;
        
        console.log(`🔓 Unduped: ${commentUrl} from ${duplicateOf}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Error undupe:', error);
        res.status(500).json({ error: error.message });
    }
});

// API: Get all PRs
app.get('/api/prs', async (req, res) => {
    try {
        const config = await loadConfig();
        if (!config || !config.repositories) {
            return res.json({ repositories: [] });
        }
        res.json({ repositories: config.repositories });
    } catch (error) {
        console.error('Error getting PRs:', error);
        res.status(500).json({ error: error.message });
    }
});

// API: Add PR
app.post('/api/prs', async (req, res) => {
    try {
        const { owner, repo, pullRequestNumber } = req.body;
        
        if (!owner || !repo || !pullRequestNumber) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const config = await loadConfig() || { repositories: [], name: 'Audit Review' };
        
        // Check if PR already exists
        const exists = config.repositories.some(r => 
            r.owner === owner && r.repo === repo && r.pullRequestNumber === pullRequestNumber
        );
        
        if (exists) {
            return res.status(400).json({ error: 'PR already exists' });
        }
        
        config.repositories.push({ owner, repo, pullRequestNumber });
        await fs.writeFile('./config.json', JSON.stringify(config, null, 2));
        
        console.log(`✅ Added PR: ${owner}/${repo}#${pullRequestNumber}`);
        res.json({ success: true, repositories: config.repositories });
    } catch (error) {
        console.error('Error adding PR:', error);
        res.status(500).json({ error: error.message });
    }
});

// API: Remove PR
app.delete('/api/prs/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const config = await loadConfig();
        
        if (!config || !config.repositories || index >= config.repositories.length) {
            return res.status(400).json({ error: 'Invalid PR index' });
        }
        
        const removed = config.repositories.splice(index, 1)[0];
        await fs.writeFile('./config.json', JSON.stringify(config, null, 2));
        
        console.log(`🗑️ Removed PR: ${removed.owner}/${removed.repo}#${removed.pullRequestNumber}`);
        res.json({ success: true, repositories: config.repositories });
    } catch (error) {
        console.error('Error removing PR:', error);
        res.status(500).json({ error: error.message });
    }
});

// API: Update all PRs (for custom labels)
app.put('/api/prs/update-all', async (req, res) => {
    try {
        const { repositories } = req.body;
        
        if (!repositories || !Array.isArray(repositories)) {
            return res.status(400).json({ error: 'Invalid repositories data' });
        }
        
        const config = await loadConfig() || { repositories: [], name: 'Audit Review' };
        config.repositories = repositories;
        
        await fs.writeFile('./config.json', JSON.stringify(config, null, 2));
        
        console.log(`✅ Updated all PRs (${repositories.length} total)`);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating PRs:', error);
        res.status(500).json({ error: error.message });
    }
});

// API: Generate PDF
app.post('/api/generate-pdf', async (req, res) => {
    try {
        const config = await loadConfig();
        if (!config || !config.repositories || config.repositories.length === 0) {
            return res.status(400).json({ error: 'No repository configured' });
        }

        const filename = `${config.name}.pdf`;
        await generatePDF(config.repositories, config.name);
        
        // Send the PDF file as download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        // PDF is generated to OUTPUT_DIR or current dir; read from there
        const outputDir = process.env.OUTPUT_DIR ? resolve(process.env.OUTPUT_DIR) : process.cwd();
        const fileBuffer = await fs.readFile(join(outputDir, filename));
        res.send(fileBuffer);
    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 Audit Review Manager Dashboard`);
    console.log(`📊 Server running at http://localhost:${PORT}`);
    console.log(`\n✨ Dashboard is live and ready!\n`);
});

