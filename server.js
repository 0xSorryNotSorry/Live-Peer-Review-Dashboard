import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { getPRReviewCommentsWithReactions, generatePDF } from './dataFetcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// In-memory undupe flags (cleared on server restart)
const undupeFlags = {};

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Load config
async function loadConfig() {
    try {
        const data = await fs.readFile('./config.json', 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading config file:', error);
        return null;
    }
}

// Load researchers config
async function loadResearchers() {
    try {
        const data = await fs.readFile('./researchers.json', 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // Create default if doesn't exist
        const defaultResearchers = {
            researchers: [],
            lsr: null
        };
        await fs.writeFile('./researchers.json', JSON.stringify(defaultResearchers, null, 2));
        return defaultResearchers;
    }
}

// Load assignments
async function loadAssignments() {
    try {
        const data = await fs.readFile('./assignments.json', 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

// Save assignments
async function saveAssignments(assignments) {
    await fs.writeFile('./assignments.json', JSON.stringify(assignments, null, 2));
}

// Save researchers config
async function saveResearchers(researchers) {
    await fs.writeFile('./researchers.json', JSON.stringify(researchers, null, 2));
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

        const repo = config.repositories[0];
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
        
        await fs.writeFile('./config.json', JSON.stringify(config, null, 4));
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
        
        const fileBuffer = await fs.readFile(filename);
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

