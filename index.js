const _ = require('lodash')
const Sentry = require('@sentry/node')

const {
  PORT,
  NODE_ENV,
  ELECTRS_URL,
  CONCURRENCY,
  SENTRY_DSN,
  BLOCKSTREAM_CLIENT_ID,
  BLOCKSTREAM_CLIENT_SECRET,
  PROXY_MODE
} = process.env

if (NODE_ENV === 'production' && SENTRY_DSN) {
  Sentry.init({ dsn: SENTRY_DSN })
}

const Bluebird = require('bluebird')
const axios = require('axios')
const express = require('express')
const helmet = require('helmet')
const compression = require('compression')
const bodyParser = require('body-parser')
const asyncHandler = require('express-async-handler')

const httpError = require('./http-error')

if (!PORT) throw new Error('Invalid PORT')
if (!ELECTRS_URL) throw new Error('Invalid ELECTRS_URL')
if (!CONCURRENCY) throw new Error('Invalid CONCURRENCY')

const app = express()

// OAuth2 token management for Blockstream API
let accessToken = null
let tokenExpiresAt = 0
let tokenRequestInProgress = null

async function getAccessToken () {
  if (!BLOCKSTREAM_CLIENT_ID || !BLOCKSTREAM_CLIENT_SECRET) {
    return null
  }

  // Check if current token is still valid (with 30s buffer)
  if (accessToken && Date.now() < tokenExpiresAt - 30000) {
    return accessToken
  }

  // If a token request is already in progress, wait for it
  if (tokenRequestInProgress) {
    return await tokenRequestInProgress
  }

  // Immediately set the promise to prevent race conditions
  tokenRequestInProgress = performTokenRequest()

  try {
    const result = await tokenRequestInProgress
    return result
  } finally {
    // Clear the in-progress promise
    tokenRequestInProgress = null
  }
}

async function performTokenRequest () {
  try {
    console.log(`[${new Date().toISOString()}] Requesting new Blockstream access token...`)

    const tokenResponse = await axios.post(
      'https://login.blockstream.com/realms/blockstream-public/protocol/openid-connect/token',
      new URLSearchParams({
        client_id: BLOCKSTREAM_CLIENT_ID,
        client_secret: BLOCKSTREAM_CLIENT_SECRET,
        grant_type: 'client_credentials',
        scope: 'openid'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    )

    accessToken = tokenResponse.data.access_token
    tokenExpiresAt = Date.now() + (tokenResponse.data.expires_in * 1000)

    console.log(`[${new Date().toISOString()}] Access token obtained, expires in ${tokenResponse.data.expires_in}s`)
    return accessToken
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Failed to get access token:`, error.message)
    return null
  }
}

// Configure axios client
const electrsConfig = { baseURL: ELECTRS_URL }
const electrs = axios.create(electrsConfig)

// Add request interceptor to handle authentication
electrs.interceptors.request.use(async (config) => {
  if (BLOCKSTREAM_CLIENT_ID && BLOCKSTREAM_CLIENT_SECRET) {
    const token = await getAccessToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
  }
  return config
})

if (NODE_ENV === 'production') {
  app.use(Sentry.Handlers.requestHandler())
}

app.use(helmet())
app.use(compression())

// Use raw body parser for transaction broadcasting endpoints
app.use('/tx', bodyParser.raw({ type: '*/*', limit: '1mb' }))
app.use('/api/tx', bodyParser.raw({ type: '*/*', limit: '1mb' }))

// Use JSON body parser for all other endpoints
app.use(bodyParser.json({ limit: '5mb' }))
app.set('etag', false)

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now()
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] ${req.method} ${req.path} - Request received`)

  // Log request body for POST requests (but limit size)
  if (req.method === 'POST' && req.body) {
    const bodyInfo = req.body.addresses ? `${req.body.addresses.length} addresses` : 'no addresses'
    console.log(`[${timestamp}] Request body: ${bodyInfo}`)
  }

  // Add response time logging
  res.on('finish', () => {
    const duration = Date.now() - start
    console.log(`[${timestamp}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`)
  })

  next()
})

// Proxy mode endpoints - these mirror esplora's API
if (PROXY_MODE === 'true') {
  // GET /address/:address - Get address information
  app.get('/address/:address', asyncHandler(async (req, res, next) => {
    const { address } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /address/${address} - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/address/${address}`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /address/${address} - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /address/:address/utxo - Get UTXOs for address
  app.get('/address/:address/utxo', asyncHandler(async (req, res, next) => {
    const { address } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /address/${address}/utxo - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/address/${address}/utxo`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /address/${address}/utxo - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /address/:address/txs - Get transactions for address
  app.get('/address/:address/txs', asyncHandler(async (req, res, next) => {
    const { address } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /address/${address}/txs - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/address/${address}/txs`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /address/${address}/txs - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /tx/:txid - Get transaction by hash
  app.get('/tx/:txid', asyncHandler(async (req, res, next) => {
    const { txid } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /tx/${txid} - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/tx/${txid}`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /tx/${txid} - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /tx/:txid/hex - Get raw transaction hex
  app.get('/tx/:txid/hex', asyncHandler(async (req, res, next) => {
    const { txid } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /tx/${txid}/hex - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/tx/${txid}/hex`)
      res.send(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /tx/${txid}/hex - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /tx/:txid/status - Get transaction status (for balance updates)
  app.get('/tx/:txid/status', asyncHandler(async (req, res, next) => {
    const { txid } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /tx/${txid}/status - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/tx/${txid}`)
      const txData = response.data

      // Transform Blockstream response to match esplora status format
      const statusResponse = {
        confirmed: txData.status?.confirmed || false,
        block_height: txData.status?.block_height || null,
        block_hash: txData.status?.block_hash || null,
        block_time: txData.status?.block_time || null
      }

      res.json(statusResponse)
    } catch (error) {
      console.log(`[${timestamp}] /tx/${txid}/status - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /tx/:txid/outspend/:vout - Get transaction output spent status
  app.get('/tx/:txid/outspend/:vout', asyncHandler(async (req, res, next) => {
    const { txid, vout } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /tx/${txid}/outspend/${vout} - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/tx/${txid}/outspend/${vout}`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /tx/${txid}/outspend/${vout} - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/tx/:txid/status - Get transaction status (for balance updates) - with /api prefix
  app.get('/api/tx/:txid/status', asyncHandler(async (req, res, next) => {
    const { txid } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/tx/${txid}/status - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/tx/${txid}`)
      const txData = response.data

      // Transform Blockstream response to match esplora status format
      const statusResponse = {
        confirmed: txData.status?.confirmed || false,
        block_height: txData.status?.block_height || null,
        block_hash: txData.status?.block_hash || null,
        block_time: txData.status?.block_time || null
      }

      res.json(statusResponse)
    } catch (error) {
      console.log(`[${timestamp}] /api/tx/${txid}/status - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/blocks/tip/height - Get current block height
  app.get('/api/blocks/tip/height', asyncHandler(async (req, res, next) => {
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/blocks/tip/height - Proxy request to Blockstream`)

    try {
      const response = await electrs.get('/blocks/tip/height')
      res.send(response.data.toString())
    } catch (error) {
      console.log(`[${timestamp}] /api/blocks/tip/height - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/tx/:txid/outspend/:vout - Get transaction output spent status - with /api prefix
  app.get('/api/tx/:txid/outspend/:vout', asyncHandler(async (req, res, next) => {
    const { txid, vout } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/tx/${txid}/outspend/${vout} - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/tx/${txid}/outspend/${vout}`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/tx/${txid}/outspend/${vout} - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/tx/:txid/outspends - Get spending status of all transaction outputs
  app.get('/api/tx/:txid/outspends', asyncHandler(async (req, res, next) => {
    const { txid } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/tx/${txid}/outspends - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/tx/${txid}/outspends`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/tx/${txid}/outspends - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/address/:address - Get address information
  app.get('/api/address/:address', asyncHandler(async (req, res, next) => {
    const { address } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/address/${address} - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/address/${address}`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/address/${address} - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/address/:address/txs - Get transaction history for address
  app.get('/api/address/:address/txs', asyncHandler(async (req, res, next) => {
    const { address } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/address/${address}/txs - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/address/${address}/txs`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/address/${address}/txs - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/address/:address/txs/chain/:last_seen_txid - Get confirmed transaction history with pagination
  app.get('/api/address/:address/txs/chain/:last_seen_txid', asyncHandler(async (req, res, next) => {
    const { address, last_seen_txid: lastSeenTxid } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/address/${address}/txs/chain/${lastSeenTxid} - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/address/${address}/txs/chain/${lastSeenTxid}`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/address/${address}/txs/chain/${lastSeenTxid} - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/address/:address/txs/chain - Get confirmed transaction history
  app.get('/api/address/:address/txs/chain', asyncHandler(async (req, res, next) => {
    const { address } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/address/${address}/txs/chain - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/address/${address}/txs/chain`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/address/${address}/txs/chain - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/address/:address/txs/mempool - Get unconfirmed transaction history
  app.get('/api/address/:address/txs/mempool', asyncHandler(async (req, res, next) => {
    const { address } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/address/${address}/txs/mempool - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/address/${address}/txs/mempool`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/address/${address}/txs/mempool - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/address/:address/utxo - Get UTXOs for address
  app.get('/api/address/:address/utxo', asyncHandler(async (req, res, next) => {
    const { address } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/address/${address}/utxo - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/address/${address}/utxo`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/address/${address}/utxo - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/block/:hash - Get block information
  app.get('/api/block/:hash', asyncHandler(async (req, res, next) => {
    const { hash } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/block/${hash} - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/block/${hash}`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/block/${hash} - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/block/:hash/status - Get block status
  app.get('/api/block/:hash/status', asyncHandler(async (req, res, next) => {
    const { hash } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/block/${hash}/status - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/block/${hash}/status`)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/block/${hash}/status - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/block-height/:height - Get block hash by height
  app.get('/api/block-height/:height', asyncHandler(async (req, res, next) => {
    const { height } = req.params
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/block-height/${height} - Proxy request to Blockstream`)

    try {
      const response = await electrs.get(`/block-height/${height}`)
      res.send(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/block-height/${height} - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/blocks/tip/hash - Get tip block hash
  app.get('/api/blocks/tip/hash', asyncHandler(async (req, res, next) => {
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/blocks/tip/hash - Proxy request to Blockstream`)

    try {
      const response = await electrs.get('/blocks/tip/hash')
      res.send(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/blocks/tip/hash - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/mempool - Get mempool statistics
  app.get('/api/mempool', asyncHandler(async (req, res, next) => {
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/mempool - Proxy request to Blockstream`)

    try {
      const response = await electrs.get('/mempool')
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/mempool - Error: ${error.message}`)
      throw error
    }
  }))

  // GET /api/fee-estimates - Get fee estimates
  app.get('/api/fee-estimates', asyncHandler(async (req, res, next) => {
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /api/fee-estimates - Proxy request to Blockstream`)

    try {
      const response = await electrs.get('/fee-estimates')
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /api/fee-estimates - Error: ${error.message}`)
      throw error
    }
  }))

  // POST /tx - Broadcast transaction
  app.post('/tx', asyncHandler(async (req, res, next) => {
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] /tx - Proxy request to Blockstream`)

    try {
      const response = await electrs.post('/tx', req.body)
      res.json(response.data)
    } catch (error) {
      console.log(`[${timestamp}] /tx - Error: ${error.message}`)
      throw error
    }
  }))

  // Health check for proxy mode
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      service: 'blockstream-proxy',
      version: '1.0.4',
      timestamp: new Date().toISOString(),
      electrs_url: ELECTRS_URL,
      proxy_mode: true
    })
  })

  // Root endpoint for proxy mode
  app.get('/', (req, res) => {
    res.json({
      service: 'blockstream-proxy',
      version: '1.0.4',
      description: 'Blockstream Enterprise API proxy with OAuth2 authentication',
      proxy_mode: true,
      electrs_url: ELECTRS_URL
    })
  })
}

// Batch API endpoints (original functionality)
app.post('/addresses', asyncHandler(async (req, res, next) => {
  const timestamp = new Date().toISOString()
  let { addresses } = req.body
  if (!addresses || !_.isArray(addresses)) {
    console.log(`[${timestamp}] /addresses - Bad request: Invalid addresses field`)
    return res.status(400).json({ error: 'Invalid "addresses" field' })
  }

  addresses = _.uniq(addresses)
  console.log(`[${timestamp}] /addresses - Processing ${addresses.length} unique addresses`)

  try {
    const response = await Bluebird.map(addresses, address => {
      return electrs.get(`/address/${address}`).then(response => response.data)
        .catch(err => {
          console.log(`[${timestamp}] /addresses - Error fetching ${address}: ${err.message}`)
          throw err
        })
    }, { concurrency: Number(CONCURRENCY) })

    console.log(`[${timestamp}] /addresses - Successfully processed ${addresses.length} addresses`)
    res.json(response)
  } catch (error) {
    console.log(`[${timestamp}] /addresses - Failed with error: ${error.message}`)
    throw error
  }
}))

app.post('/addresses/utxo', asyncHandler(async (req, res, next) => {
  const timestamp = new Date().toISOString()
  let { addresses } = req.body
  if (!addresses || !_.isArray(addresses)) {
    console.log(`[${timestamp}] /addresses/utxo - Bad request: Invalid addresses field`)
    return res.status(400).json({ error: 'Invalid "addresses" field' })
  }

  addresses = _.uniq(addresses)
  console.log(`[${timestamp}] /addresses/utxo - Processing ${addresses.length} unique addresses`)

  try {
    const response = await Bluebird.map(addresses, address => {
      return electrs.get(`/address/${address}/utxo`).then(response => ({
        address,
        utxo: response.data
      })).catch(err => {
        console.log(`[${timestamp}] /addresses/utxo - Error fetching UTXOs for ${address}: ${err.message}`)
        throw err
      })
    }, { concurrency: Number(CONCURRENCY) })

    console.log(`[${timestamp}] /addresses/utxo - Successfully processed ${addresses.length} addresses`)
    res.json(response)
  } catch (error) {
    console.log(`[${timestamp}] /addresses/utxo - Failed with error: ${error.message}`)
    throw error
  }
}))

app.post('/addresses/transactions', asyncHandler(async (req, res, next) => {
  const timestamp = new Date().toISOString()
  let { addresses } = req.body
  if (!addresses || !_.isArray(addresses)) {
    console.log(`[${timestamp}] /addresses/transactions - Bad request: Invalid addresses field`)
    return res.status(400).json({ error: 'Invalid "addresses" field' })
  }

  addresses = _.uniq(addresses)
  console.log(`[${timestamp}] /addresses/transactions - Processing ${addresses.length} unique addresses`)

  try {
    const response = await Bluebird.map(addresses, address => {
      return electrs.get(`/address/${address}/txs`).then(response => ({
        address,
        transaction: response.data
      })).catch(err => {
        console.log(`[${timestamp}] /addresses/transactions - Error fetching transactions for ${address}: ${err.message}`)
        throw err
      })
    }, { concurrency: Number(CONCURRENCY) })

    console.log(`[${timestamp}] /addresses/transactions - Successfully processed ${addresses.length} addresses`)
    res.json(response)
  } catch (error) {
    console.log(`[${timestamp}] /addresses/transactions - Failed with error: ${error.message}`)
    throw error
  }
}))

// POST /tx - Broadcast transaction (for batch mode)
app.post('/tx', asyncHandler(async (req, res, next) => {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] /tx - Broadcasting transaction`)
  console.log(`[${timestamp}] /tx - Request Content-Type: ${req.get('Content-Type')}`)
  console.log(`[${timestamp}] /tx - Request body type: ${typeof req.body}`)
  console.log(`[${timestamp}] /tx - Request body is Buffer: ${Buffer.isBuffer(req.body)}`)

  // Convert buffer to string if needed
  let txHex = req.body
  if (Buffer.isBuffer(req.body)) {
    txHex = req.body.toString('utf8')
    console.log(`[${timestamp}] /tx - Converted buffer to string: ${txHex.substring(0, 100)}...`)
  } else if (typeof req.body === 'object' && req.body !== null) {
    console.log(`[${timestamp}] /tx - Request body (JSON): ${JSON.stringify(req.body)}`)
  } else {
    console.log(`[${timestamp}] /tx - Raw body: ${req.body}`)
  }

  console.log(`[${timestamp}] /tx - Final transaction hex: ${typeof txHex === 'string' ? txHex : 'NOT A STRING: ' + JSON.stringify(txHex)}`)

  if (typeof txHex !== 'string' || txHex.length === 0) {
    console.log(`[${timestamp}] /tx - Invalid transaction hex`)
    return res.status(400).json({
      error: 'Invalid transaction hex',
      message: 'Transaction hex must be a non-empty string'
    })
  }

  try {
    const response = await electrs.post('/tx', txHex)
    console.log(`[${timestamp}] /tx - Transaction broadcast successful: ${response.data}`)
    res.send(response.data)
  } catch (error) {
    console.log(`[${timestamp}] /tx - Error broadcasting transaction: ${error.message}`)
    console.log(`[${timestamp}] /tx - Failed transaction hex (full): ${txHex}`)

    // Handle specific broadcast errors gracefully
    if (error.response) {
      const status = error.response.status
      const message = error.response.data || error.message
      console.log(`[${timestamp}] /tx - Blockstream API error: ${status} - ${message}`)
      return res.status(status).json({
        error: 'Transaction broadcast failed',
        message: message,
        status: status
      })
    }

    throw error
  }
}))

// GET /api/tx/:txid - Get transaction by hash (for batch mode)
app.get('/api/tx/:txid', asyncHandler(async (req, res, next) => {
  const { txid } = req.params
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] /api/tx/${txid} - Request received`)

  try {
    const response = await electrs.get(`/tx/${txid}`)
    res.json(response.data)
  } catch (error) {
    console.log(`[${timestamp}] /api/tx/${txid} - Error: ${error.message}`)
    throw error
  }
}))

// GET /api/tx/:txid/hex - Get raw transaction hex (for batch mode)
app.get('/api/tx/:txid/hex', asyncHandler(async (req, res, next) => {
  const { txid } = req.params
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] /api/tx/${txid}/hex - Request received`)

  try {
    const response = await electrs.get(`/tx/${txid}/hex`)
    res.send(response.data)
  } catch (error) {
    console.log(`[${timestamp}] /api/tx/${txid}/hex - Error: ${error.message}`)
    throw error
  }
}))

// GET /api/tx/:txid/status - Get transaction status (for batch mode)
app.get('/api/tx/:txid/status', asyncHandler(async (req, res, next) => {
  const { txid } = req.params
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] /api/tx/${txid}/status - Request received`)

  try {
    const response = await electrs.get(`/tx/${txid}`)
    const txData = response.data

    // Transform Blockstream response to match esplora status format
    const statusResponse = {
      confirmed: txData.status?.confirmed || false,
      block_height: txData.status?.block_height || null,
      block_hash: txData.status?.block_hash || null,
      block_time: txData.status?.block_time || null
    }

    res.json(statusResponse)
  } catch (error) {
    console.log(`[${timestamp}] /api/tx/${txid}/status - Error: ${error.message}`)
    throw error
  }
}))

// POST /api/tx - Broadcast transaction (for batch mode with /api prefix)
app.post('/api/tx', asyncHandler(async (req, res, next) => {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] /api/tx - Broadcasting transaction`)
  console.log(`[${timestamp}] /api/tx - Request Content-Type: ${req.get('Content-Type')}`)
  console.log(`[${timestamp}] /api/tx - Request body type: ${typeof req.body}`)
  console.log(`[${timestamp}] /api/tx - Request body is Buffer: ${Buffer.isBuffer(req.body)}`)

  // Convert buffer to string if needed
  let txHex = req.body
  if (Buffer.isBuffer(req.body)) {
    txHex = req.body.toString('utf8')
    console.log(`[${timestamp}] /api/tx - Converted buffer to string: ${txHex.substring(0, 100)}...`)
  } else if (typeof req.body === 'object' && req.body !== null) {
    console.log(`[${timestamp}] /api/tx - Request body (JSON): ${JSON.stringify(req.body)}`)
    // If body is JSON object, look for common transaction hex fields
    if (req.body.hex) {
      txHex = req.body.hex
    } else if (req.body.rawTransaction) {
      txHex = req.body.rawTransaction
    } else if (req.body.transaction) {
      txHex = req.body.transaction
    } else {
      console.log(`[${timestamp}] /api/tx - Invalid request format. Expected hex string or object with hex field`)
      return res.status(400).json({
        error: 'Invalid request format',
        message: 'Expected raw transaction hex string in request body or object with hex field'
      })
    }
  } else {
    console.log(`[${timestamp}] /api/tx - Raw body: ${req.body}`)
  }

  console.log(`[${timestamp}] /api/tx - Final transaction hex: ${typeof txHex === 'string' ? txHex : 'NOT A STRING: ' + JSON.stringify(txHex)}`)

  if (typeof txHex !== 'string' || txHex.length === 0) {
    console.log(`[${timestamp}] /api/tx - Invalid transaction hex`)
    return res.status(400).json({
      error: 'Invalid transaction hex',
      message: 'Transaction hex must be a non-empty string'
    })
  }

  try {
    const response = await electrs.post('/tx', txHex)
    console.log(`[${timestamp}] /api/tx - Transaction broadcast successful: ${response.data}`)
    res.send(response.data)
  } catch (error) {
    console.log(`[${timestamp}] /api/tx - Error broadcasting transaction: ${error.message}`)
    console.log(`[${timestamp}] /api/tx - Failed transaction hex (full): ${txHex}`)

    // Handle specific broadcast errors gracefully
    if (error.response) {
      const status = error.response.status
      const message = error.response.data || error.message
      console.log(`[${timestamp}] /api/tx - Blockstream API error: ${status} - ${message}`)
      return res.status(status).json({
        error: 'Transaction broadcast failed',
        message: message,
        status: status
      })
    }

    throw error
  }
}))

// Health check endpoint (for batch mode)
if (PROXY_MODE !== 'true') {
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      service: 'electrs-batch-server',
      version: '1.0.4',
      timestamp: new Date().toISOString(),
      electrs_url: ELECTRS_URL,
      concurrency: CONCURRENCY
    })
  })

  // Root endpoint with API info (for batch mode)
  app.get('/', (req, res) => {
    res.json({
      service: 'electrs-batch-server',
      version: '1.0.4',
      description: 'Electrs middleware server for batch API calls',
      endpoints: [
        'POST /addresses - Get address information for multiple addresses',
        'POST /addresses/utxo - Get UTXOs for multiple addresses',
        'POST /addresses/transactions - Get transactions for multiple addresses',
        'POST /tx - Broadcast raw transaction',
        'POST /api/tx - Broadcast raw transaction (with /api prefix)',
        'GET /health - Health check endpoint'
      ],
      electrs_url: ELECTRS_URL,
      concurrency: CONCURRENCY
    })
  })
}

app.all('/*', function (req, res) {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] 404 - Unknown endpoint: ${req.method} ${req.path}`)

  if (PROXY_MODE === 'true') {
    res.status(404).json({
      error: '404',
      message: 'Endpoint not found',
      service: 'blockstream-proxy'
    })
  } else {
    res.status(404).json({
      error: '404',
      message: 'Endpoint not found',
      available_endpoints: ['/addresses', '/addresses/utxo', '/addresses/transactions', '/tx', '/api/tx', '/health']
    })
  }
})

app.use((err, req, res, next) => {
  const status = err.statusCode || 500
  const message = err.message || err.toString()

  if (NODE_ENV !== 'production') {
    console.error(err)
  }

  return httpError(req, res, status, message)
})

app.listen(PORT, () => {
  console.log(`=== ${PROXY_MODE === 'true' ? 'Blockstream Proxy' : 'Electrs Batch Server'} Started ===`)
  console.log(`Port: ${PORT}`)
  console.log(`Node Environment: ${NODE_ENV || 'development'}`)
  console.log(`Electrs URL: ${ELECTRS_URL}`)
  console.log(`Concurrency: ${CONCURRENCY}`)
  console.log(`API Authentication: ${BLOCKSTREAM_CLIENT_ID ? 'ENABLED' : 'DISABLED'}`)
  console.log(`Proxy Mode: ${PROXY_MODE === 'true' ? 'ENABLED' : 'DISABLED'}`)
  console.log(`Time: ${new Date().toISOString()}`)
  console.log('=====================================')
})
