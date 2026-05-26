const fs = require('fs');
const axios = require('axios');
require('dotenv').config();

const path = require('path');
const TOKENS_PATH = path.join(__dirname, 'tokens.json');

function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_PATH)) {
      throw new Error(
        `${TOKENS_PATH} not found. Run the initial OAuth flow to generate it.`
      );
    }
    const raw = fs.readFileSync(TOKENS_PATH, 'utf8');
    const tokens = JSON.parse(raw);

    if (!tokens.refresh_token) {
      throw new Error(`${TOKENS_PATH} is missing a refresh_token.`);
    }
    return tokens;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`${TOKENS_PATH} contains invalid JSON: ${err.message}`);
    }
    throw err;
  }
}

async function getValidToken() {
  const tokens = loadTokens();

  if (tokens.expires_at && Date.now() < tokens.expires_at) {
    return tokens.access_token;
  }

  // Token expired (or no expiry recorded), refresh it
  const credentials = Buffer.from(
    `${process.env.BLUEBEAM_CLIENT_ID}:${process.env.BLUEBEAM_CLIENT_SECRET}`
  ).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  });

  let response;
  try {
    response = await axios.post(
      'https://api.bluebeam.com/oauth2/token',
      body.toString(),
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    throw new Error(`Failed to refresh Bluebeam token: ${detail}`);
  }

  const newTokens = response.data;
  newTokens.expires_at = Date.now() + (newTokens.expires_in - 60) * 1000;

  // Preserve refresh token if a new one was not issued
  if (!newTokens.refresh_token) {
    newTokens.refresh_token = tokens.refresh_token;
  }

  fs.writeFileSync(TOKENS_PATH, JSON.stringify(newTokens, null, 2));
  return newTokens.access_token;
}

module.exports = { getValidToken };
