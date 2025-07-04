# Discord Bot

This is a Discord bot with several features, including Markov chain-based text generation, auto-response, and voice channel management.

## Features

- **Markov Chain Text Generation:** The bot can learn from messages in a text channel and generate new sentences using Markov chains.
- **Auto-response:** The bot can automatically respond when mentioned or at random intervals.
- **Voice Channel Management:** The bot can move users who have been muted for an extended period to a specific voice channel.
- **Slash Commands:** The bot can be controlled with slash commands such as `/crawling`, `/generate`, `/stats`, and `/autoresponse`.

## Getting Started

### Prerequisites

- Node.js
- pnpm

### Installation

1. Clone the repository.
2. Install the dependencies with `pnpm install`.
3. Create a `.env` file and set the following environment variables:
   - `DISCORD_BOT_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID` (for testing)
   - `INACTIVE_CHANNEL_ID`
   - `MESSAGE_CRAWLING_ID`
   - `ADMIN_USER_ID`
4. Build the project with `pnpm run build`.
5. Start the bot with `pnpm run start`.

## Commands

- `/crawling [count]`: Crawls messages to update the Markov chain database.
- `/generate [length] [input]`: Generates a sentence using the Markov chain.
- `/stats`: Displays database statistics.
- `/autoresponse [mode]`: Changes the auto-response mode.
