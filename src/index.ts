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

// ========== PUBLIC PROFILE ==========
app.get('/public/profile/:username', async (req, res) => {
  const { username } = req.params;
  
  try {
    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Fetch GitHub data using stored token
    const reposRes = await axios.get('https://api.github.com/user/repos?sort=updated&per_page=6&affiliation=owner,collaborator', {
      headers: { Authorization: `Bearer ${user.access_token}` }
    });

    const eventsRes = await axios.get(`https://api.github.com/users/${user.username}/events/public?per_page=30`, {
      headers: { Authorization: `Bearer ${user.access_token}` }
    });

    // Process timeline
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
      user: {
        username: user.username,
        name: user.name || user.username,
        avatar: user.avatar_url,
        bio: user.bio,
      },
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
    console.error('Public profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ========== MESSAGING ==========

// Send a staked message
app.post('/messages/send', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { receiver_username, content, stake_amount = 0 } = req.body;
  if (!receiver_username || !content) {
    return res.status(400).json({ error: 'receiver_username and content required' });
  }

  try {
    const db = await getDb();
    
    // Find receiver
    const receiver = await db.get('SELECT id FROM users WHERE username = ?', [receiver_username]);
    if (!receiver) return res.status(404).json({ error: 'Receiver not found' });
    if (receiver.id === user.id) return res.status(400).json({ error: 'Cannot message yourself' });

    const result = await db.run(
      `INSERT INTO messages (sender_id, receiver_id, content, stake_amount, status) 
       VALUES (?, ?, ?, ?, ?)`,
      [user.id, receiver.id, content, stake_amount, 'pending']
    );

    res.json({ 
      success: true, 
      message_id: result.lastID,
      stake: stake_amount 
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get conversations list (who you've messaged or who messaged you)
app.get('/messages/conversations', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const db = await getDb();
    const conversations = await db.all(`
      SELECT 
        u.username,
        u.name,
        u.avatar_url,
        m.content as last_message,
        m.stake_amount,
        m.status,
        m.created_at,
        m.sender_id,
        (SELECT COUNT(*) FROM messages 
         WHERE sender_id = u.id AND receiver_id = ? AND status = 'pending') as unread_count
      FROM messages m
      JOIN users u ON (
        (m.sender_id = ? AND m.receiver_id = u.id) OR 
        (m.receiver_id = ? AND m.sender_id = u.id)
      )
      WHERE m.id = (
        SELECT id FROM messages 
        WHERE (sender_id = ? AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = ?)
        ORDER BY created_at DESC LIMIT 1
      )
      GROUP BY u.id
      ORDER BY m.created_at DESC
    `, [user.id, user.id, user.id, user.id, user.id]);

    res.json(conversations.map(c => ({
      username: c.username,
      name: c.name,
      avatar: c.avatar_url,
      lastMessage: c.last_message,
      stake: c.stake_amount,
      status: c.status,
      date: c.created_at,
      isIncoming: c.sender_id !== user.id,
      unread: c.unread_count
    })));
  } catch (error) {
    console.error('Conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get messages between current user and another user
app.get('/messages/:username', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { username } = req.params;
  
  try {
    const db = await getDb();
    const other = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (!other) return res.status(404).json({ error: 'User not found' });

    const messages = await db.all(`
      SELECT m.*, s.username as sender_username, s.avatar_url as sender_avatar
      FROM messages m
      JOIN users s ON m.sender_id = s.id
      WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
      ORDER BY m.created_at ASC
    `, [user.id, other.id, other.id, user.id]);

    res.json(messages.map(m => ({
      id: m.id,
      content: m.content,
      stake: m.stake_amount,
      status: m.status,
      date: m.created_at,
      sender: m.sender_username,
      senderAvatar: m.sender_avatar,
      isMine: m.sender_id === user.id
    })));
  } catch (error) {
    console.error('Messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Respond to a message (accept/reject)
app.post('/messages/:id/respond', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.params;
  const { action } = req.body; // 'accept' or 'reject'

  if (!['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Action must be accept or reject' });
  }

  try {
    const db = await getDb();
    const message = await db.get(
      'SELECT * FROM messages WHERE id = ? AND receiver_id = ?',
      [id, user.id]
    );

    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.status !== 'pending') return res.status(400).json({ error: 'Already responded' });

    const newStatus = action === 'accept' ? 'accepted' : 'rejected';
    await db.run('UPDATE messages SET status = ? WHERE id = ?', [newStatus, id]);

    res.json({ 
      success: true, 
      status: newStatus,
      stake: action === 'accept' ? message.stake_amount : 0
    });
  } catch (error) {
    console.error('Respond error:', error);
    res.status(500).json({ error: 'Failed to respond' });
  }
});

// ========== DISCOVER USERS ==========
app.get('/discover/users', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const db = await getDb();
    const users = await db.all(
      `SELECT username, name, avatar_url, bio 
       FROM users 
       WHERE id != ? 
       ORDER BY created_at DESC 
       LIMIT 20`,
      [user.id]
    );

    res.json(users.map(u => ({
      username: u.username,
      name: u.name || u.username,
      avatar: u.avatar_url,
      bio: u.bio || 'No bio yet'
    })));
  } catch (error) {
    console.error('Discover error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
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