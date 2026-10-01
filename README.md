# StoreShots MCP

[![npm](https://img.shields.io/npm/v/storeshots-api-mcp)](https://www.npmjs.com/package/storeshots-api-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-uk.co.qaimos.storeshots%2Fstoreshots-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=uk.co.qaimos.storeshots/storeshots)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=storeshots&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInN0b3Jlc2hvdHMtYXBpLW1jcCJdLCJlbnYiOnsiU1RPUkVTSE9UU19BUElfS0VZIjoic3NfeW91cl9rZXlfaGVyZSJ9fQ==)

Turn raw app screenshots into polished **App Store and Google Play marketing screenshots** from Cursor, Claude, or any other MCP client.

This is a small stdio MCP server that talks to the hosted [StoreShots](https://storeshots.qaimos.co.uk/) API. Rendering happens on the server, so you don't need Chrome, Puppeteer, or a design tool on your machine. Give your agent a few screenshots and some headlines, and it saves store-ready PNGs (or a ZIP) into your project.

- 1–5 screenshots per set, from local files or URLs
- 5 curated styles: `glow`, `midnight`, `sunset`, `mint`, `trailing`, plus custom colours
- Device frames: `iphone`, `iphone-duo`, `android`, `ipad`
- Every required store size in one call: `ios-6.9` (1320×2868), `ios-6.5` (1242×2688), `android-phone` (1080×1920), `ipad-13` (2064×2752)
- Headlines and captions for each slide
- Downloads a ZIP and/or PNGs straight into your project

## Quick start

### 1. Get a free API key

Sign up with your email at **https://storeshots.qaimos.co.uk/account.html**. The key (`ss_...`) is only shown once, so copy it somewhere safe.

### 2. Add the server to your MCP client

**Cursor**: add this to `~/.cursor/mcp.json` (or to `.cursor/mcp.json` in a project). You can also use the "Install in Cursor" button above.

```json
{
  "mcpServers": {
    "storeshots": {
      "command": "npx",
      "args": ["-y", "storeshots-api-mcp"],
      "env": { "STORESHOTS_API_KEY": "ss_your_key_here" }
    }
  }
}
```

**Claude Desktop**: open Settings → Developer → Edit Config, then add the same block to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "storeshots": {
      "command": "npx",
      "args": ["-y", "storeshots-api-mcp"],
      "env": { "STORESHOTS_API_KEY": "ss_your_key_here" }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add storeshots --env STORESHOTS_API_KEY=ss_your_key_here -- npx -y storeshots-api-mcp
```

**VS Code, Windsurf, and other clients**: run `npx -y storeshots-api-mcp` over stdio with `STORESHOTS_API_KEY` set in the environment.

Requires Node.js 18.17 or newer.

### 3. Ask your agent

> Make App Store screenshots from ./shots/home.png and ./shots/stats.png in the midnight style with the headlines "Build habits that stick" and "See your progress", and save them to ./store-assets.

## Tools

| Tool | What it does |
|---|---|
| `list_styles` | Lists the available styles with their colours and layouts |
| `list_devices` | Lists the device frames and store output sizes |
| `generate_screenshots` | Renders one set from `screenshots` (1–5 paths or URLs). Optional inputs: `style`, `device`, `targets[]`, `headlines[]`, `captions[]`, `appName`, `theme` (colour overrides), `download_to`, and `download_format` (`zip` \| `png` \| `both`). Returns a `jobId` |
| `get_output` | Downloads a job's ZIP and/or PNGs to `output_dir`. Outputs are kept for 24h |
| `get_balance` | Shows your paid credits, the free sets left this month, and the available credit packs |
| `buy_credits` | Returns a Stripe Payment Link for a pack, which you open in the browser. The tool itself never charges you |

## Configuration

| Variable | Required | Default |
|---|---|---|
| `STORESHOTS_API_KEY` | yes | none. Get a free key at [account.html](https://storeshots.qaimos.co.uk/account.html) |
| `STORESHOTS_API_URL` | no | `https://storeshots.qaimos.co.uk/api.php` |
| `STORESHOTS_OUTPUT_DIR` | no | `~/StoreShots` (the default download folder) |
| `STORESHOTS_TIMEOUT_MS` | no | `300000` |

## Pricing

- **Free**: 3 sets per month, with a small "Made with StoreShots" watermark
- **Starter**: 10 sets for $3, no watermark
- **Pro**: 20 sets for $5, no watermark

Each set is one `generate_screenshots` call and includes every size you ask for. You can buy them with `buy_credits` or on [storeshots.qaimos.co.uk](https://storeshots.qaimos.co.uk/).

## Privacy

Screenshots are uploaded over HTTPS to the StoreShots API, rendered there, and deleted after 24 hours. Your API key is sent as an `X-API-Key` header.

## Development

```bash
npm install
npm run inspect   # opens the MCP Inspector against src/index.js
```

`npm test` runs an end-to-end test against a local copy of the StoreShots PHP API, which isn't part of this repo.

## Links

- Website: https://storeshots.qaimos.co.uk/
- npm: https://www.npmjs.com/package/storeshots-api-mcp
- MCP Registry: `uk.co.qaimos.storeshots/storeshots`
- Issues: https://github.com/qaimos/storeshots-mcp/issues

## License

MIT
