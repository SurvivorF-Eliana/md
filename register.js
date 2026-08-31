'use strict';

require('dotenv').config();

const { REST, Routes } = require('discord.js');

const {
  DISCORD_APP_ID,
  DISCORD_TOKEN
} = process.env;

if (!DISCORD_APP_ID) {
  console.error('❌ Missing DISCORD_APP_ID in .env');
  process.exit(1);
}

if (!DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const commands = [
  {
    name: 'neomark',
    description: 'Open the NeoMark Markdown workspace.'
  }
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  try {
    console.log('↻ Registering global /neomark command...');

    await rest.put(
      Routes.applicationCommands(DISCORD_APP_ID),
      {
        body: commands
      }
    );

    console.log('✓ Global /neomark command registered successfully.');
  } catch (error) {
    console.error('❌ Failed to register command:');
    console.error(error);
    process.exit(1);
  }
}

registerCommands();