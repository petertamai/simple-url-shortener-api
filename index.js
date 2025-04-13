// File: index.js

require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const nanoid = require('nanoid');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

// Constants
const PORT = process.env.PORT || 3444;
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'http://localhost:3444';
const CODE_LENGTH = 6; // Length of short URL code
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'urls.db');

// Create logs directory if it doesn't exist
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Create db directory if it doesn't exist
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir);
}

// Create a write stream for logging
const accessLogStream = fs.createWriteStream(
  path.join(logDir, 'access.log'),
  { flags: 'a' }
);

// App initialization
const app = express();

// Middleware
app.use(morgan('combined', { stream: accessLogStream }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error:`, err);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: err.message
  });
});

// Database initialization
let db;
async function initDb() {
  try {
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });
    
    await db.exec(`
      CREATE TABLE IF NOT EXISTS urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_url TEXT NOT NULL UNIQUE,
        short_code TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        access_count INTEGER DEFAULT 0
      )
    `);
    
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exit(1);
  }
}

// Generate a unique short code
async function generateUniqueCode() {
  const generateCode = () => nanoid.nanoid(CODE_LENGTH);
  let code = generateCode();
  let exists = await db.get('SELECT 1 FROM urls WHERE short_code = ?', code);
  
  while (exists) {
    code = generateCode();
    exists = await db.get('SELECT 1 FROM urls WHERE short_code = ?', code);
  }
  
  return code;
}

// Helper function to process a single URL
async function processSingleUrl(originalUrl) {
  if (!originalUrl) {
    return { error: 'URL is required' };
  }
  
  // Check if URL is valid
  try {
    new URL(originalUrl);
  } catch (err) {
    return { error: 'Invalid URL format', originalUrl };
  }
  
  // Check if URL already exists in database
  const existingUrl = await db.get(
    'SELECT short_code FROM urls WHERE original_url = ?', 
    originalUrl
  );
  
  if (existingUrl) {
    const shortUrl = `${BASE_DOMAIN}/${existingUrl.short_code}`;
    return { 
      originalUrl, 
      shortUrl,
      shortCode: existingUrl.short_code
    };
  }
  
  // Generate a unique short code
  const shortCode = await generateUniqueCode();
  
  // Insert the new URL into the database
  await db.run(
    'INSERT INTO urls (original_url, short_code) VALUES (?, ?)',
    [originalUrl, shortCode]
  );
  
  const shortUrl = `${BASE_DOMAIN}/${shortCode}`;
  
  return { 
    originalUrl, 
    shortUrl,
    shortCode
  };
}

// Routes
app.get('/api/shorten', async (req, res, next) => {
  try {
    const originalUrl = req.query.url;
    
    if (!originalUrl) {
      return res.status(400).json({ 
        error: 'Bad Request', 
        message: 'URL parameter is required' 
      });
    }
    
    const result = await processSingleUrl(originalUrl);
    
    if (result.error) {
      return res.status(400).json({ 
        error: 'Bad Request', 
        message: result.error 
      });
    }
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Batch URL shortening endpoint
app.post('/api/shorten/batch', express.json(), async (req, res, next) => {
  try {
    const urls = req.body;
    
    if (!Array.isArray(urls)) {
      return res.status(400).json({ 
        error: 'Bad Request', 
        message: 'Request body must be an array of URLs' 
      });
    }
    
    if (urls.length === 0) {
      return res.status(400).json({ 
        error: 'Bad Request', 
        message: 'At least one URL is required' 
      });
    }
    
    // Limit batch size for performance reasons
    if (urls.length > 100) {
      return res.status(400).json({ 
        error: 'Bad Request', 
        message: 'Maximum batch size is 100 URLs' 
      });
    }
    
    const results = await Promise.all(
      urls.map(async (url) => {
        return await processSingleUrl(url);
      })
    );
    
    res.json(results);
  } catch (error) {
    next(error);
  }
});

// Redirect from short URL to original URL
app.get('/:code', async (req, res, next) => {
  try {
    const { code } = req.params;
    
    const url = await db.get(
      'SELECT original_url FROM urls WHERE short_code = ?', 
      code
    );
    
    if (url) {
      // Update access count
      await db.run(
        'UPDATE urls SET access_count = access_count + 1 WHERE short_code = ?', 
        code
      );
      
      return res.redirect(url.original_url);
    }
    
    res.status(404).json({ 
      error: 'Not Found', 
      message: 'Short URL not found' 
    });
  } catch (error) {
    next(error);
  }
});

// Stats endpoint (optional)
app.get('/api/stats/:code', async (req, res, next) => {
  try {
    const { code } = req.params;
    
    const stats = await db.get(
      'SELECT original_url, short_code, created_at, access_count FROM urls WHERE short_code = ?', 
      code
    );
    
    if (stats) {
      return res.json(stats);
    }
    
    res.status(404).json({ 
      error: 'Not Found', 
      message: 'Short URL not found' 
    });
  } catch (error) {
    next(error);
  }
});

// Catch-all route
app.get('*', (req, res) => {
  res.status(404).json({ 
    error: 'Not Found', 
    message: 'Endpoint not found' 
  });
});

// Start the server
async function startServer() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`URL Shortener API running on port ${PORT}`);
    console.log(`Base domain: ${BASE_DOMAIN}`);
  });
}  

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = app; // For testing purposes