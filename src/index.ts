import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { initDb, getDb } from './db';
import { Resend } from 'resend';
dotenv.config();

import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY || '');


// ========== EMAIL NOTIFICATIONS ==========
async function sendMessageEmail(receiverEmail: string, senderName: string, messagePreview: string, stakeAmount: number) {
  if (!process.env.RESEND_API_KEY) return;
  
  try {
    await resend.emails.send({
      from: 'KYNTRA <notifications@kyntra.dev>',
      to: receiverEmail,
      subject: stakeAmount > 0 
        ? `${senderName} staked ${stakeAmount} KYN to message you` 
        : `${senderName} sent you a message on KYNTRA`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1e293b;">New Message on KYNTRA</h2>
          <p><strong>${senderName}</strong> sent you a message:</p>
          <div style="background: #f8fafc; border-left: 4px solid #7c3aed; padding: 15px; margin: 15px 0; border-radius: 8px;">
            <p style="margin: 0; color: #334155;">"${messagePreview}"</p>
          </div>
          ${stakeAmount > 0 ? `<p style="color: #d97706; font-weight: bold;">⚡ Stake: ${stakeAmount} KYN</p>` : ''}
          <a href="https://kyntra-pi.vercel.app/message" style="display: inline-block; background: #0f172a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin-top: 15px; font-weight: bold;">Reply on KYNTRA</a>
          <p style="color: #94a3b8; font-size: 12px; margin-top: 20px;">You're receiving this because you have a KYNTRA account.</p>
        </div>
      `
    });
    console.log('📧 Email sent to', receiverEmail);
  } catch (err) {
    console.error('Email failed:', err);
  }
}

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
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// Helper to get user from JWT
async function getUserFromToken(authHeader: string | undefined) {
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const db = await getDb();
    const result = await db.query('SELECT * FROM users WHERE github_id = $1', [decoded.userId]);
    return result.rows[0] || null;
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
    
    await db.query(
      `INSERT INTO users (github_id, username, email, avatar_url, name, bio, access_token) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (github_id) 
       DO UPDATE SET username = $2, email = $3, avatar_url = $4, name = $5, bio = $6, access_token = $7`,
      [githubUser.id, githubUser.login, githubUser.email, githubUser.avatar_url, githubUser.name, githubUser.bio, accessToken]
    );

    const userResult = await db.query('SELECT id FROM users WHERE github_id = $1', [githubUser.id]);
    const user = userResult.rows[0];

    await db.query(
      `INSERT INTO connections (user_id, provider, provider_user_id, access_token) 
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, provider) 
       DO UPDATE SET access_token = $4`,
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
    await db.query(
      `INSERT INTO connections (user_id, provider, access_token) 
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, provider) 
       DO UPDATE SET access_token = $3`,
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
    await db.query(
      `INSERT INTO connections (user_id, provider, access_token) 
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, provider) 
       DO UPDATE SET access_token = $3`,
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
  const result = await db.query('SELECT provider, connected_at FROM connections WHERE user_id = $1', [user.id]);
  res.json(result.rows);
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
    const reposRes = await axios.get('https://api.github.com/user/repos?sort=updated&per_page=6&affiliation=owner,collaborator', {
      headers: { Authorization: `Bearer ${user.access_token}` }
    });

    const eventsRes = await axios.get(`https://api.github.com/users/${user.username}/events/public?per_page=30`, {
      headers: { Authorization: `Bearer ${user.access_token}` }
    });

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
    const userResult = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = userResult.rows[0];
    
    if (!user) return res.status(404).json({ error: 'User not found' });

    const reposRes = await axios.get('https://api.github.com/user/repos?sort=updated&per_page=6&affiliation=owner,collaborator', {
      headers: { Authorization: `Bearer ${user.access_token}` }
    });

    const eventsRes = await axios.get(`https://api.github.com/users/${user.username}/events/public?per_page=30`, {
      headers: { Authorization: `Bearer ${user.access_token}` }
    });

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

// ========== DISCOVER USERS ==========
app.get('/discover/users', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const db = await getDb();
    const result = await db.query(
      `SELECT username, name, avatar_url, bio 
       FROM users 
       WHERE id != $1 
       ORDER BY created_at DESC 
       LIMIT 20`,
      [user.id]
    );

    res.json(result.rows.map((u: any) => ({
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

// ========== MESSAGING ==========
app.post('/messages/send', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { receiver_username, content, stake_amount = 0 } = req.body;
  if (!receiver_username || !content) {
    return res.status(400).json({ error: 'receiver_username and content required' });
  }

  try {
    const db = await getDb();
    
    const receiverResult = await db.query('SELECT id FROM users WHERE username = $1', [receiver_username]);
    const receiver = receiverResult.rows[0];
    
    if (!receiver) return res.status(404).json({ error: 'Receiver not found' });
    if (receiver.id === user.id) return res.status(400).json({ error: 'Cannot message yourself' });

        const result = await db.query(
      `INSERT INTO messages (sender_id, receiver_id, content, stake_amount, status) 
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [user.id, receiver.id, content, stake_amount, 'pending']
    );

    // Send email notification
    const senderResult = await db.query('SELECT name FROM users WHERE id = $1', [user.id]);
    const senderName = senderResult.rows[0]?.name || user.username;
    
    const receiverEmailResult = await db.query('SELECT email FROM users WHERE id = $1', [receiver.id]);
    const receiverEmail = receiverEmailResult.rows[0]?.email;
    
    if (receiverEmail) {
      sendMessageEmail(receiverEmail, senderName, content.substring(0, 100), stake_amount);
    }

    res.json({ 
      success: true, 
      message_id: result.rows[0].id,
      stake: stake_amount 
    });

app.get('/messages/conversations', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const db = await getDb();
    const result = await db.query(`
      SELECT DISTINCT ON (u.id)
        u.username,
        u.name,
        u.avatar_url,
        m.content as last_message,
        m.stake_amount,
        m.status,
        m.created_at,
        m.sender_id,
        (SELECT COUNT(*) FROM messages 
         WHERE sender_id = u.id AND receiver_id = $1 AND status = 'pending') as unread_count
      FROM messages m
      JOIN users u ON (
        (m.sender_id = $1 AND m.receiver_id = u.id) OR 
        (m.receiver_id = $1 AND m.sender_id = u.id)
      )
      ORDER BY u.id, m.created_at DESC
    `, [user.id]);

    res.json(result.rows.map((c: any) => ({
      username: c.username,
      name: c.name,
      avatar: c.avatar_url,
      lastMessage: c.last_message,
      stake: c.stake_amount,
      status: c.status,
      date: c.created_at,
      isIncoming: c.sender_id !== user.id,
      unread: parseInt(c.unread_count)
    })));
  } catch (error) {
    console.error('Conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

app.get('/messages/:username', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { username } = req.params;
  
  try {
    const db = await getDb();
    const otherResult = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    const other = otherResult.rows[0];
    
    if (!other) return res.status(404).json({ error: 'User not found' });

    const result = await db.query(`
      SELECT m.*, s.username as sender_username, s.avatar_url as sender_avatar
      FROM messages m
      JOIN users s ON m.sender_id = s.id
      WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)
      ORDER BY m.created_at ASC
    `, [user.id, other.id]);

    res.json(result.rows.map((m: any) => ({
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

app.post('/messages/:id/respond', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.params;
  const { action } = req.body;

  if (!['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Action must be accept or reject' });
  }

  try {
    const db = await getDb();
    const msgResult = await db.query(
      'SELECT * FROM messages WHERE id = $1 AND receiver_id = $2',
      [id, user.id]
    );
    const message = msgResult.rows[0];

    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.status !== 'pending') return res.status(400).json({ error: 'Already responded' });

    const newStatus = action === 'accept' ? 'accepted' : 'rejected';
    await db.query('UPDATE messages SET status = $1 WHERE id = $2', [newStatus, id]);

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

// ========== AI SEMANTIC SKILL GRAPH ==========

async function fetchGitHubWorkSamples(accessToken: string, username: string) {
  try {
    const [reposRes, eventsRes] = await Promise.all([
      axios.get('https://api.github.com/user/repos?sort=updated&per_page=10&affiliation=owner,collaborator', {
        headers: { Authorization: `Bearer ${accessToken}` }
      }),
      axios.get(`https://api.github.com/users/${username}/events/public?per_page=20`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
    ]);

    const repos = reposRes.data.map((r: any) => ({
      name: r.name,
      description: r.description || '',
      language: r.language || 'Unknown',
      stars: r.stargazers_count,
      topics: r.topics || []
    }));

    const events = eventsRes.data
      .filter((e: any) => ['PushEvent', 'PullRequestEvent', 'CreateEvent'].includes(e.type))
      .map((e: any) => {
        if (e.type === 'PushEvent') {
          const commits = e.payload.commits || [];
          return `Pushed to ${e.repo.name}: ${commits.map((c: any) => c.message).join('; ')}`;
        }
        if (e.type === 'PullRequestEvent') {
          return `PR ${e.payload.action} in ${e.repo.name}: ${e.payload.pull_request?.title || ''}`;
        }
        if (e.type === 'CreateEvent' && e.payload.ref_type === 'repository') {
          return `Created repository ${e.repo.name}`;
        }
        return '';
      })
      .filter(Boolean);

    return { repos, events };
  } catch (error) {
    console.error('GitHub fetch error:', error);
    return { repos: [], events: [] };
  }
}

app.post('/ai/generate-skill-graph', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'AI not configured' });
  }

  try {
    const { repos, events } = await fetchGitHubWorkSamples(user.access_token, user.username);
    
    const workContext = `
GITHUB REPOSITORIES:
${repos.map((r: any) => `- ${r.name} (${r.language}, ${r.stars} stars): ${r.description} [Topics: ${r.topics.join(', ') || 'none'}]`).join('\n')}

RECENT ACTIVITY:
${events.slice(0, 15).join('\n')}

USER BIO: ${user.bio || 'None'}
`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: `You are an expert technical recruiter and engineering manager who deeply understands software architecture. 
Analyze the developer's work artifacts and generate a "skill fingerprint" — a semantic understanding of what they actually build, not just what languages they use.

Return ONLY valid JSON. No markdown, no explanation.`
          },
          {
            role: 'user',
            content: `Analyze this developer's work and return a JSON object with this exact structure:

{
  "deep_skills": ["specific capabilities inferred from work"],
  "tech_stack": {
    "primary": ["main languages/frameworks"],
    "secondary": ["things they touch occasionally"],
    "infrastructure": ["databases, cloud, devops tools"]
  },
  "architecture_patterns": ["patterns evident in their work"],
  "collaboration_style": "One sentence: how they work with others",
  "impact_areas": ["domains they impact"],
  "experience_level": "Junior / Mid / Senior / Staff",
  "complementary_to": ["types of people/teams who would benefit most"],
  "unique_signals": ["rare or distinctive capabilities"],
  "summary": "One compelling sentence describing what this developer uniquely brings"
}

Work artifacts:
${workContext}`
          }
        ],
        temperature: 0.3,
        max_tokens: 1500
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'Groq API error');
    }

    const completion = await response.json();
    const aiResponse = completion.choices[0].message.content || '{}';
    const skillGraph = JSON.parse(aiResponse);

    const db = await getDb();
    await db.query(
      'UPDATE users SET skill_graph = $1 WHERE id = $2',
      [JSON.stringify(skillGraph), user.id]
    );

    res.json({ success: true, skill_graph: skillGraph });
  } catch (error: any) {
    console.error('AI generation error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to generate skill graph' });
  }
});

// ========== AI-POWERED DISCOVER ==========
app.get('/discover/matches', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const db = await getDb();
    
    const meResult = await db.query('SELECT skill_graph FROM users WHERE id = $1', [user.id]);
    const myGraph = meResult.rows[0]?.skill_graph;
    
    if (!myGraph) {
      return res.status(400).json({ error: 'Generate your skill graph first' });
    }

    const othersResult = await db.query(
      `SELECT id, username, name, avatar_url, bio, skill_graph 
       FROM users 
       WHERE id != $1 AND skill_graph IS NOT NULL
       LIMIT 10`,
      [user.id]
    );

    if (othersResult.rows.length === 0) {
      return res.json({ matches: [] });
    }

    const matchesContext = othersResult.rows.map((u: any) => `
USER: ${u.name} (@${u.username})
BIO: ${u.bio || 'None'}
SKILLS: ${JSON.stringify(u.skill_graph)}
`).join('\n---\n');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: `You are a world-class engineering team builder. Great teams are built on COMPLEMENTARY skills, not identical ones.`
          },
          {
            role: 'user',
            content: `I am a developer with this skill fingerprint:
${JSON.stringify(myGraph, null, 2)}

Here are other developers:
${matchesContext}

For EACH developer, analyze complementary fit. Return ONLY a JSON array:

[
  {
    "username": "their username",
    "match_score": 0-100,
    "match_type": "complementary" | "similar" | "mentor" | "mentee",
    "reasoning": "One sentence explaining why we should connect",
    "collaboration_potential": "What we could build together"
  }
]

Be specific. Reference actual skills.`
          }
        ],
        temperature: 0.4,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'Groq API error');
    }

    const completion = await response.json();
    const aiResponse = completion.choices[0].message.content || '[]';
    const matchResults = JSON.parse(aiResponse);

    const enrichedMatches = matchResults.map((match: any) => {
      const userData = othersResult.rows.find((u: any) => u.username === match.username);
      return {
        ...match,
        name: userData?.name || match.username,
        avatar: userData?.avatar_url,
        bio: userData?.bio
      };
    }).sort((a: any, b: any) => b.match_score - a.match_score);

    res.json({ matches: enrichedMatches });
  } catch (error: any) {
    console.error('AI matching error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to generate matches' });
  }
});

// ========== SEARCH DEVELOPERS ==========
app.get('/discover/search', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { q } = req.query;
  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: 'Query required' });
  }

  try {
    const db = await getDb();
    const searchTerm = `%${q.toLowerCase()}%`;
    
    const result = await db.query(
      `SELECT username, name, avatar_url, bio, skill_graph 
       FROM users 
       WHERE id != $1 AND (
         LOWER(username) LIKE $2 OR 
         LOWER(name) LIKE $2 OR 
         LOWER(bio) LIKE $2 OR
         skill_graph::text ILIKE $2
       )
       LIMIT 20`,
      [user.id, searchTerm]
    );

    res.json(result.rows.map((u: any) => ({
      username: u.username,
      name: u.name || u.username,
      avatar: u.avatar_url,
      bio: u.bio || 'No bio yet',
      skillGraph: u.skill_graph
    })));
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// START SERVER
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 KYNTRA API running on port ${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});