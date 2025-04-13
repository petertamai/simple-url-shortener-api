# URL Shortener API

A simple, efficient API for creating shortened URLs with unique codes. Built with Node.js, Express, and SQLite.

## Features

- Create shortened URLs via GET request
- Check and return existing URLs to avoid duplicates
- Configurable base domain via environment variables
- Statistics for URL usage
- PM2-ready for production deployment
- Comprehensive error handling and logging

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Configure your environment variables in `.env` file:

```
PORT=3444
BASE_DOMAIN="https://your-domain.com"
DB_PATH="./db/urls.db"
```

## Usage

### Starting the server

Development mode:
```bash
npm run dev
```

Production mode:
```bash
npm start
```

With PM2:
```bash
pm2 start ecosystem.config.js
```

### API Endpoints

#### Shorten a URL
```
GET /api/shorten?url=https://example.com/very-long-url
```

Response:
```json
{
  "originalUrl": "https://example.com/very-long-url",
  "shortUrl": "https://your-domain.com/abc123",
  "shortCode": "abc123"
}
```

#### Access URL statistics
```
GET /api/stats/abc123
```

Response:
```json
{
  "original_url": "https://example.com/very-long-url",
  "short_code": "abc123",
  "created_at": "2023-10-26T14:30:00.000Z",
  "access_count": 42
}
```

#### Redirect to original URL
```
GET /:code
```
Example: `https://your-domain.com/abc123` redirects to the original URL

## Project Structure

```
url-shortener-api/
├── index.js           # Main application file
├── package.json       # Dependencies and scripts
├── ecosystem.config.js # PM2 configuration
├── .env               # Environment variables
├── db/                # Database directory
│   └── urls.db        # SQLite database
└── logs/              # Log files
    ├── access.log     # API access logs
    ├── pm2-error.log  # PM2 error logs
    └── pm2-out.log    # PM2 output logs
```

## Requirements

- Node.js >= 14.0.0
- PM2 (for production)

## License

MIT

## Author

Piotr Tamulewicz <pt@petertam.pro>