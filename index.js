'use strict';

require('dotenv').config();

const express = require('express');
const {
  InteractionType,
  InteractionResponseType,
  verifyKey
} = require('discord-interactions');

const {
  DISCORD_PUBLIC_KEY,
  DISCORD_TOKEN,
  PORT = 3000
} = process.env;

const app = express();

const FIXED_PUBLIC_KEY =
  '27d1bf548fb21f5ef5fd958d60f1e1573cf97fc6a6ddbae56fc19b2cdf4c9120';

const PUBLIC_KEY = FIXED_PUBLIC_KEY || DISCORD_PUBLIC_KEY;

const DISCORD_API_BASE = 'https://discord.com/api/v10';

const INTERACTIONS_PATH = '/interactions';

const CUSTOM_IDS = {
  EDIT_MARKDOWN: 'neomark:edit',
  MODAL: 'neomark:modal',
  MARKDOWN_INPUT: 'neomark:markdown'
};

const EMBED_COLOR = 0x8A5CF6;

function requireEnvironment() {
  if (!DISCORD_TOKEN) {
    throw new Error('Missing DISCORD_TOKEN in environment variables.');
  }

  if (!PUBLIC_KEY) {
    throw new Error('Missing Discord public key.');
  }
}

requireEnvironment();

/**
 * Discord requires us to verify the exact raw request payload.
 * Using express.raw() here ensures the bytes remain untouched until
 * signature verification is complete.
 */
app.post(
  INTERACTIONS_PATH,
  express.raw({
    type: 'application/json',
    limit: '256kb'
  }),
  async (req, res) => {
    try {
      const signature = req.header('X-Signature-Ed25519');
      const timestamp = req.header('X-Signature-Timestamp');

      if (!signature || !timestamp) {
        return res.status(401).send('Missing Discord signature headers.');
      }

      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(req.body || '');

      const isValid = await verifyKey(
        rawBody,
        signature,
        timestamp,
        PUBLIC_KEY
      );

      if (!isValid) {
        return res.status(401).send('Bad request signature.');
      }

      let interaction;

      try {
        interaction = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).send('Invalid JSON payload.');
      }

      return await handleInteraction(interaction, res);
    } catch (error) {
      console.error('❌ Interaction handler error:', error);

      if (!res.headersSent) {
        return res.status(500).json({
          error: 'Internal Server Error'
        });
      }
    }
  }
);

app.get('/', (_req, res) => {
  res.status(200).json({
    name: 'NeoMark',
    status: 'online',
    mode: 'Discord Interactions Endpoint',
    endpoint: INTERACTIONS_PATH
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'neomark'
  });
});

async function handleInteraction(interaction, res) {
  switch (interaction.type) {
    case InteractionType.PING:
      return res.status(200).json({
        type: InteractionResponseType.PONG
      });

    case InteractionType.APPLICATION_COMMAND:
      return handleApplicationCommand(interaction, res);

    case InteractionType.MESSAGE_COMPONENT:
      return handleMessageComponent(interaction, res);

    case InteractionType.MODAL_SUBMIT:
      return handleModalSubmit(interaction, res);

    default:
      return res.status(400).json({
        error: `Unsupported interaction type: ${interaction.type}`
      });
  }
}

/**
 * Handles /neomark.
 */
function handleApplicationCommand(interaction, res) {
  const commandName = interaction?.data?.name;

  if (commandName !== 'neomark') {
    return res.status(400).json({
      error: 'Unknown application command.'
    });
  }

  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        buildNeoMarkEmbed({
          characters: 0,
          words: 0,
          readingTime: '0m 00s',
          hasDocument: false
        })
      ],
      components: [
        buildEditButton()
      ]
    }
  });
}

/**
 * Opens the native Discord Modal.
 */
function handleMessageComponent(interaction, res) {
  const customId = interaction?.data?.custom_id;

  if (customId !== CUSTOM_IDS.EDIT_MARKDOWN) {
    return res.status(400).json({
      error: 'Unknown component.'
    });
  }

  return res.status(200).json({
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: CUSTOM_IDS.MODAL,
      title: 'NeoMark · Edit Markdown',
      components: [
        {
          type: 18,
          label: 'Markdown',
          description: 'Paste or write the Markdown document.',
          component: {
            type: 4,
            custom_id: CUSTOM_IDS.MARKDOWN_INPUT,
            style: 2,
            label: 'Markdown source',
            placeholder: '# NeoMark\\n\\nWrite your Markdown here...',
            required: true,
            min_length: 1,
            max_length: 4000
          }
        }
      ]
    }
  });
}

/**
 * Handles Modal submit and updates the original interaction message.
 */
async function handleModalSubmit(interaction, res) {
  const customId = interaction?.data?.custom_id;

  if (customId !== CUSTOM_IDS.MODAL) {
    return res.status(400).json({
      error: 'Unknown modal.'
    });
  }

  const markdown = getModalValue(
    interaction.data.components,
    CUSTOM_IDS.MARKDOWN_INPUT
  );

  const metrics = calculateMarkdownMetrics(markdown);

  try {
    await editOriginalInteractionResponse(
      interaction.token,
      {
        embeds: [
          buildNeoMarkEmbed({
            characters: metrics.characters,
            words: metrics.words,
            readingTime: metrics.readingTime,
            hasDocument: true
          })
        ],
        components: [
          buildEditButton()
        ]
      }
    );

    /**
     * We acknowledge the modal submission only after the original
     * response has been updated successfully.
     *
     * Empty deferred ACK is valid here.
     */
    return res.status(200).json({
      type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE
    });
  } catch (error) {
    console.error('❌ Failed to update original response:', error);

    /**
     * Discord can still receive a valid interaction response.
     * The failure is surfaced in logs without exposing internals.
     */
    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: '⚠️ NeoMark could not update the document.',
        flags: 64
      }
    });
  }
}

/**
 * Reads a Text Input value from Discord's Modal component structure.
 */
function getModalValue(components, targetCustomId) {
  if (!Array.isArray(components)) {
    return '';
  }

  for (const row of components) {
    const rowComponents = Array.isArray(row?.components)
      ? row.components
      : [];

    for (const component of rowComponents) {
      if (component?.custom_id === targetCustomId) {
        return String(component.value || '');
      }
    }
  }

  return '';
}

/**
 * Calculates basic reading metrics for Markdown.
 *
 * Words:
 * - whitespace-delimited tokens
 *
 * Characters:
 * - JavaScript Unicode code points, excluding CR/LF line breaks
 *
 * Reading time:
 * - 200 words per minute
 */
function calculateMarkdownMetrics(markdown) {
  const source = String(markdown || '');

  const characters = [...source.replace(/\r?\n/g, '')].length;

  const normalized = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[#>*_~]/g, ' ')
    .replace(/[-+]\s+/g, ' ')
    .trim();

  const words = normalized
    ? normalized.split(/\s+/).filter(Boolean).length
    : 0;

  const WORDS_PER_MINUTE = 200;

  const totalSeconds = words === 0
    ? 0
    : Math.ceil((words / WORDS_PER_MINUTE) * 60);

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  const readingTime = `${minutes}m ${String(seconds).padStart(2, '0')}s`;

  return {
    characters,
    words,
    readingTime
  };
}

/**
 * Main NeoMark HUD-style embed.
 */
function buildNeoMarkEmbed({
  characters,
  words,
  readingTime,
  hasDocument
}) {
  const documentState = hasDocument
    ? 'DOCUMENT // ANALYZED'
    : 'DOCUMENT // WAITING FOR INPUT';

  return {
    title: '◆ NEOMARK // MARKDOWN WORKSPACE',
    description:
      '```text\n' +
      '┌──────────────────────────────────────────────┐\n' +
      '│  NEO MARK // INDUSTRIAL MARKDOWN INTERFACE   │\n' +
      '├──────────────────────────────────────────────┤\n' +
      `│  STATUS : ${documentState.padEnd(31, ' ')}│\n` +
      '└──────────────────────────────────────────────┘\n' +
      '```',
    color: EMBED_COLOR,
    fields: [
      {
        name: 'CHARACTERS',
        value: `\`${characters.toLocaleString('en-US')}\``,
        inline: true
      },
      {
        name: 'WORDS',
        value: `\`${words.toLocaleString('en-US')}\``,
        inline: true
      },
      {
        name: 'READ TIME',
        value: `\`${readingTime}\``,
        inline: true
      }
    ],
    footer: {
      text: 'NeoMark • Markdown Intelligence Layer'
    },
    timestamp: new Date().toISOString()
  };
}

/**
 * Discord Button component.
 */
function buildEditButton() {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        label: 'Edit Markdown',
        emoji: {
          name: '📝'
        },
        custom_id: CUSTOM_IDS.EDIT_MARKDOWN
      }
    ]
  };
}

/**
 * PATCH @original using the interaction webhook token.
 */
async function editOriginalInteractionResponse(token, payload) {
  const url =
    `${DISCORD_API_BASE}/webhooks/${getApplicationId()}/${token}/messages/@original`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await safeReadBody(response);

    throw new Error(
      `Discord PATCH @original failed (${response.status}): ${body}`
    );
  }

  return response;
}

/**
 * Discord requires application ID for webhook message operations.
 */
function getApplicationId() {
  const applicationId = process.env.DISCORD_APP_ID;

  if (!applicationId) {
    throw new Error(
      'DISCORD_APP_ID is required in .env for webhook message updates.'
    );
  }

  return applicationId;
}

async function safeReadBody(response) {
  try {
    return await response.text();
  } catch {
    return '<unreadable response body>';
  }
}

const server = app.listen(PORT, () => {
  console.log('────────────────────────────────────────────');
  console.log(' NeoMark // Discord Interactions Endpoint');
  console.log('────────────────────────────────────────────');
  console.log(` HTTP      : http://localhost:${PORT}`);
  console.log(` Endpoint  : ${INTERACTIONS_PATH}`);
  console.log(' Gateway   : disabled');
  console.log(' Status    : online');
  console.log('────────────────────────────────────────────');
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down...');
  server.close(() => {
    process.exit(0);
  });
});