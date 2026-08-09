import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { initDb, getDb } from './db';

dotenv.config();

const app = express();
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://kyntra-pi.vercel.app',
    'https://kyntra.vercel.app'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const PORT = 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'kyntra-dev-secret-change-in-production';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const FIGMA_CLIENT_ID = process.env.FIGMA_CLIENT_ID || '';
const FIGMA_CLIENT_SECRET = process.env.FIGMA_CLIENT_SECRET || '';
const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID || '';
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET || '';

// Helper to get user from JWT
async function getUserFromToken(authHeader: string | undefined) {
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE github_id = ?', [decoded.userId]);
    return user;
  } catch {
    return null;
  }
}

// ========== GITHUB OAUTH ==========
app.get('/auth/github', (req, res) => {
  const redirectUri = 'https://kyntra-api.onrender.com/auth/github/callback';
  const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${redirectUri}&scope=user:email,read:user`;
  res.json({ url });
});

app.get('/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  try {
    const tokenRes = await axios.post('https://github.com/login/oauth/access_token', {
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
    }, { headers: { Accept: 'application/json' } });

    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const githubUser = userRes.data;

    const db = await getDb();
    await db.run(
      `INSERT OR REPLACE INTO users (github_id, username, email, avatar_url, name, bio, access_token) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [githubUser.id, githubUser.login, githubUser.email, githubUser.avatar_url, githubUser.name, githubUser.bio, accessToken]
    );

    const user = await db.get('SELECT id FROM users WHERE github_id = ?', [githubUser.id]);
    await db.run(
      `INSERT OR REPLACE INTO connections (user_id, provider, provider_user_id, access_token) 
       VALUES (?, ?, ?, ?)`,
      [user.id, 'github', githubUser.id, accessToken]
    );

    const token = jwt.sign({ userId: githubUser.id, username: githubUser.login }, JWT_SECRET, { expiresIn: '7d' });
    res.redirect(`https://kyntra-pi.vercel.app/auth/callback?token=${token}`);
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ========== FIGMA OAUTH ==========
app.get('/auth/figma', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const state = Buffer.from(JSON.stringify({ userId: user.id })).toString('base64');
  const redirectUri = 'https://kyntra-api.onrender.com/auth/figma/callback';
  const url = `https://www.figma.com/oauth?client_id=${FIGMA_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=file_read&state=${state}&response_type=code`;
  res.json({ url });
});

app.get('/auth/figma/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).json({ error: 'Missing params' });

  try {
    const { userId } = JSON.parse(Buffer.from(state as string, 'base64').toString());
    const tokenRes = await axios.post('https://www.figma.com/api/oauth/token', {
      client_id: FIGMA_CLIENT_ID,
      client_secret: FIGMA_CLIENT_SECRET,
      redirect_uri: 'https://kyntra-api.onrender.com/auth/figma/callback',
      code,
      grant_type: 'authorization_code'
    });

    const db = await getDb();
    await db.run(
      `INSERT OR REPLACE INTO connections (user_id, provider, access_token) 
       VALUES (?, ?, ?)`,
      [userId, 'figma', tokenRes.data.access_token]
    );

    res.redirect('https://kyntra-pi.vercel.app/profile?connected=figma');
  } catch (error) {
    console.error('Figma OAuth error:', error);
    res.status(500).json({ error: 'Figma auth failed' });
  }
});

// ========== NOTION OAUTH ==========
app.get('/auth/notion', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const state = Buffer.from(JSON.stringify({ userId: user.id })).toString('base64');
  const redirectUri = encodeURIComponent('https://kyntra-api.onrender.com/auth/notion/callback');
  const url = `https://api.notion.com/v1/oauth/authorize?client_id=${NOTION_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&state=${state}`;
  res.json({ url });
});

app.get('/auth/notion/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).json({ error: 'Missing params' });

  try {
    const { userId } = JSON.parse(Buffer.from(state as string, 'base64').toString());
    const tokenRes = await axios.post('https://api.notion.com/v1/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://kyntra-api.onrender.com/auth/notion/callback'
    }, {
      auth: { username: NOTION_CLIENT_ID, password: NOTION_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/json' }
    });

    const db = await getDb();
    await db.run(
      `INSERT OR REPLACE INTO connections (user_id, provider, access_token) 
       VALUES (?, ?, ?)`,
      [userId, 'notion', tokenRes.data.access_token]
    );

    res.redirect('https://kyntra-pi.vercel.app/profile?connected=notion');
  } catch (error) {
    console.error('Notion OAuth error:', error);
    res.status(500).json({ error: 'Notion auth failed' });
  }
});

// ========== GET USER CONNECTIONS ==========
app.get('/connections', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const db = await getDb();
  const connections = await db.all('SELECT provider, connected_at FROM connections WHERE user_id = ?', [user.id]);
  res.json(connections);
});

// ========== GET CURRENT USER ==========
app.get('/me', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  
  res.json({
    id: user.github_id,
    username: user.username,
    name: user.name || user.username,
    email: user.email,
    avatar: user.avatar_url,
    bio: user.bio
  });
});

// ========== GITHUB TIMELINE ==========
app.get('/github/timeline', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  try {
    // Fetch user's repos
    const reposRes = await axios.get('https://api.github.com/user/repos?sort=updated&per_page=6&affiliation=owner,collaborator', {
      headers: { Authorization: `Bearer ${user.access_token}` }
    });

    // Fetch public events (commits, PRs, etc.)
    const eventsRes = await axios.get(`https://api.github.com/users/${user.username}/events/public?per_page=30`, {
      headers: { Authorization: `Bearer ${user.access_token}` }
    });

    // Process events into timeline
    const timeline: any[] = [];
    const seen = new Set();

    for (const event of eventsRes.data) {
      const key = `${event.type}-${event.repo.name}-${event.created_at}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (event.type === 'PushEvent') {
        const commits = event.payload.commits || [];
        if (commits.length > 0) {
          timeline.push({
            type: 'commit',
            repo: event.repo.name,
            message: commits[0].message,
            commits: commits.length,
            date: event.created_at,
            sha: commits[0].sha.substring(0, 7)
          });
        }
      } else if (event.type === 'PullRequestEvent') {
        const pr = event.payload.pull_request;
        timeline.push({
          type: 'pr',
          repo: event.repo.name,
          title: pr.title,
          action: event.payload.action,
          merged: pr.merged,
          date: event.created_at,
          number: pr.number
        });
      } else if (event.type === 'CreateEvent' && event.payload.ref_type === 'repository') {
        timeline.push({
          type: 'repo',
          repo: event.repo.name,
          date: event.created_at
        });
      }

      if (timeline.length >= 12) break;
    }

    res.json({
      repos: reposRes.data.map((r: any) => ({
        name: r.name,
        full_name: r.full_name,
        description: r.description,
        stars: r.stargazers_count,
        language: r.language,
        updated_at: r.updated_at,
        url: r.html_url,
        forks: r.forks_count
      })),
      timeline
    });
  } catch (error) {
    console.error('GitHub timeline error:', error);
    res.status(500).json({ error: 'Failed to fetch GitHub data' });
  }
});

// START SERVER
initDb().then(() => {
  console.log('✅ SQLite database initialized');
  app.listen(PORT, () => {
    console.log(`🚀 KYNTRA API running on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});