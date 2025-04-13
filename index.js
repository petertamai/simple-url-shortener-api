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
const MAX_BATCH_SIZE = 50; // Reduced from 100 to save memory

// Create logs directory if it doesn't exist
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Create db directory if it doesn't exist
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Create a write stream for logging
const accessLogStream = fs.createWriteStream(
  path.join(logDir, 'access.log'),
  { flags: 'a' }
);

// App initialization
const app = express();
let server;
let db;

// Middleware - only use what's necessary
app.use(morgan('combined', { stream: accessLogStream }));
app.use(express.json({ limit: '1mb' })); // Limit payload size
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Database initialization
async function initDb() {
  try {
    if (db) {
      // Already initialized
      return;
    }
    
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });
    
    // Set pragmas for better performance
    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA synchronous = NORMAL;');
    await db.exec('PRAGMA cache_size = 1000;');
    await db.exec('PRAGMA temp_store = MEMORY;');
    
    await db.exec(`
      CREATE TABLE IF NOT EXISTS urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_url TEXT NOT NULL UNIQUE,
        short_code TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        access_count INTEGER DEFAULT 0
      )
    `);
    
    // Add index on short_code for faster lookups
    await db.exec('CREATE INDEX IF NOT EXISTS idx_short_code ON urls(short_code);');
    
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
  
  let attempts = 0;
  const maxAttempts = 10;
  
  while (exists && attempts < maxAttempts) {
    code = generateCode();
    exists = await db.get('SELECT 1 FROM urls WHERE short_code = ?', code);
    attempts++;
  }
  
  if (attempts >= maxAttempts) {
    throw new Error('Failed to generate a unique code after multiple attempts');
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
  
  // Trim URL to prevent storage issues
  originalUrl = originalUrl.trim();
  if (originalUrl.length > 2048) {
    return { error: 'URL exceeds maximum length (2048 characters)', originalUrl };
  }
  
  try {
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
  } catch (error) {
    console.error('Error processing URL:', error);
    return { error: 'Internal Server Error', originalUrl };
  }
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
    console.error('Error in GET /api/shorten:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred'
    });
  }
});

// Batch URL shortening endpoint
app.post('/api/shorten/batch', async (req, res) => {
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
    if (urls.length > MAX_BATCH_SIZE) {
      return res.status(400).json({ 
        error: 'Bad Request', 
        message: `Maximum batch size is ${MAX_BATCH_SIZE} URLs` 
      });
    }
    
    // Process URLs in chunks to avoid memory issues
    const chunkSize = 10;
    const results = [];
    
    for (let i = 0; i < urls.length; i += chunkSize) {
      const chunk = urls.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(
        chunk.map(url => processSingleUrl(url))
      );
      results.push(...chunkResults);
    }
    
    res.json(results);
  } catch (error) {
    console.error('Error in POST /api/shorten/batch:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred'
    });
  }
});

// Redirect from short URL to original URL
app.get('/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    // Validate code format to prevent SQL injection
    if (!code || code.length > 20 || /[^\w-]/.test(code)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid short code format'
      });
    }
    
    const url = await db.get(
      'SELECT original_url FROM urls WHERE short_code = ?', 
      code
    );
    
    if (url) {
      // Update access count asynchronously (don't wait for it)
      db.run(
        'UPDATE urls SET access_count = access_count + 1 WHERE short_code = ?', 
        code
      ).catch(err => console.error('Error updating access count:', err));
      
      return res.redirect(url.original_url);
    }
    
    res.status(404).json({ 
      error: 'Not Found', 
      message: 'Short URL not found' 
    });
  } catch (error) {
    console.error('Error in GET /:code:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred'
    });
  }
});

// Stats endpoint (optional)
app.get('/api/stats/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    // Validate code format
    if (!code || code.length > 20 || /[^\w-]/.test(code)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid short code format'
      });
    }
    
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
    console.error('Error in GET /api/stats/:code:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Catch-all route
app.get('*', (req, res) => {
  res.status(404).json({ 
    error: 'Not Found', 
    message: 'Endpoint not found' 
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error:`, err);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred'
  });
});

// Graceful shutdown
function gracefulShutdown() {
  console.log('Shutting down gracefully...');
  
  // Close the server first, stop accepting new requests
  if (server) {
    server.close(() => {
      console.log('Server closed');
      
      // Close the database connection
      if (db) {
        db.close()
          .then(() => {
            console.log('Database connection closed');
            process.exit(0);
          })
          .catch(err => {
            console.error('Error closing database:', err);
            process.exit(1);
          });
      } else {
        process.exit(0);
      }
    });
  } else {
    process.exit(0);
  }
  
  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
}

// Handle termination signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  gracefulShutdown();
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  // Don't shut down for unhandled promise rejections
});

// Start the server
async function startServer() {
  try {
    await initDb();
    server = app.listen(PORT, () => {
      console.log(`URL Shortener API running on port ${PORT}`);
      console.log(`Base domain: ${BASE_DOMAIN}`);
    });
    
    server.keepAliveTimeout = 65000; // Increase from default 5000ms
    server.headersTimeout = 66000; // Increase from default 60000ms
    
    return server;
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer }; // For testing purposes